package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func testApp(t *testing.T) *App {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "file:" + t.TempDir() + "/db.sqlite"
	}
	if strings.HasPrefix(dsn, "postgres") {
		admin, e := sql.Open("pgx", dsn)
		if e != nil {
			t.Fatal(e)
		}
		schema := "test_" + token()[:16]
		if _, e = admin.Exec("CREATE SCHEMA " + schema); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() })
		parsed, _ := url.Parse(dsn)
		q := parsed.Query()
		q.Set("search_path", schema)
		parsed.RawQuery = q.Encode()
		dsn = parsed.String()
	}
	t.Setenv("DATABASE_URL", dsn)
	t.Setenv("ADMIN_PASSWORD", "initial-password")
	t.Setenv("BASE_PATH", "/artifacts")
	a, e := newApp()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { a.db.Close() })
	return a
}
func req(a *App, method, path string, body any, key string, cookie *http.Cookie, csrf string) *httptest.ResponseRecorder {
	var b bytes.Buffer
	if body != nil {
		json.NewEncoder(&b).Encode(body)
	}
	r := httptest.NewRequest(method, path, &b)
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if csrf != "" {
		r.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func obj(t *testing.T, w *httptest.ResponseRecorder, status int) map[string]any {
	t.Helper()
	if w.Code != status {
		t.Fatalf("expected %d got %d: %s", status, w.Code, w.Body.String())
	}
	v := map[string]any{}
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func login(t *testing.T, a *App, name string) (*http.Cookie, string) {
	t.Helper()
	w := req(a, "POST", "/artifacts/api/login", map[string]string{"name": name, "password": "initial-password"}, "", nil, "")
	v := obj(t, w, 200)
	return w.Result().Cookies()[0], v["csrf"].(string)
}
func key(t *testing.T, a *App, name string) string {
	t.Helper()
	c, s := login(t, a, name)
	w := req(a, "POST", "/artifacts/api/keys", map[string]string{"name": "CLI"}, "", c, s)
	return obj(t, w, 201)["key"].(string)
}
func TestPublishPermissionsAndLifecycle(t *testing.T) {
	a := testApp(t)
	for _, name := range []string{"alice", "bob", "eve"} {
		if e := a.createUser(name, "initial-password", false); e != nil {
			t.Fatal(e)
		}
	}
	alice := key(t, a, "alice")
	bob := key(t, a, "bob")
	eve := key(t, a, "eve")
	var bid string
	a.row("SELECT id FROM users WHERE name=?", "bob").Scan(&bid)
	v := map[string]any{"title": "Architecture", "kind": "md", "content": "# Diagram\n```mermaid\ngraph LR\n A --> B\n```", "visibility": "users", "users": []string{bid}}
	out := obj(t, req(a, "POST", "/artifacts/api/artifacts", v, alice, nil, ""), 201)
	id := out["id"].(string)
	share := "/artifacts/api/share?id=" + id
	for _, k := range []string{alice, bob} {
		obj(t, req(a, "GET", share, nil, k, nil, ""), 200)
	}
	for _, k := range []string{"", eve} {
		obj(t, req(a, "GET", share, nil, k, nil, ""), 404)
	}
	obj(t, req(a, "DELETE", "/artifacts/api/artifacts/"+id, nil, bob, nil, ""), 403)
	v["visibility"] = "link"
	v["kind"] = "html"
	v["content"] = "<h1>Published</h1><script>console.log('hello')</script>"
	obj(t, req(a, "PUT", "/artifacts/api/artifacts/"+id, v, alice, nil, ""), 200)
	obj(t, req(a, "GET", share, nil, "", nil, ""), 200)
	w := req(a, "GET", "/artifacts/s/"+id+"/raw", nil, "", nil, "")
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox allow-scripts") {
		t.Fatal("HTML sandbox missing")
	}
	v["users"] = []string{"missing"}
	obj(t, req(a, "PUT", "/artifacts/api/artifacts/"+id, v, alice, nil, ""), 400)
	obj(t, req(a, "DELETE", "/artifacts/api/artifacts/"+id, nil, alice, nil, ""), 200)
	obj(t, req(a, "GET", share, nil, "", nil, ""), 404)
}
func TestSessionKeyAdminAndSubpath(t *testing.T) {
	a := testApp(t)
	c, s := login(t, a, "admin")
	obj(t, req(a, "POST", "/artifacts/api/keys", map[string]string{"name": "CLI"}, "", c, ""), 403)
	w := req(a, "POST", "/artifacts/api/keys", map[string]string{"name": "CLI"}, "", c, s)
	v := obj(t, w, 201)
	k, id := v["key"].(string), v["id"].(string)
	obj(t, req(a, "GET", "/artifacts/api/me", nil, k, nil, ""), 200)
	obj(t, req(a, "DELETE", "/artifacts/api/keys/"+id, nil, "", c, s), 200)
	obj(t, req(a, "GET", "/artifacts/api/me", nil, k, nil, ""), 401)
	obj(t, req(a, "POST", "/artifacts/api/admin/users", map[string]any{"name": "reader", "password": "initial-password", "admin": false}, "", c, s), 201)
	reader := key(t, a, "reader")
	obj(t, req(a, "GET", "/artifacts/api/admin/users", nil, reader, nil, ""), 403)
	var rid string
	a.row("SELECT id FROM users WHERE name=?", "reader").Scan(&rid)
	rc, _ := login(t, a, "reader")
	obj(t, req(a, "PATCH", "/artifacts/api/admin/users/"+rid, map[string]string{"password": "new-password"}, "", c, s), 200)
	obj(t, req(a, "GET", "/artifacts/api/me", nil, "", rc, ""), 401)
	for _, p := range []string{"/artifacts/", "/artifacts/assets/app.js", "/artifacts/assets/style.css", "/healthz", "/artifacts/api/config"} {
		w := req(a, "GET", p, nil, "", nil, "")
		if w.Code != 200 {
			t.Errorf("%s returned %d", p, w.Code)
		}
	}
	if req(a, "GET", "/", nil, "", nil, "").Code != 404 {
		t.Fatal("base prefix ignored")
	}
	obj(t, req(a, "POST", "/artifacts/api/logout", nil, "", c, s), 200)
	obj(t, req(a, "GET", "/artifacts/api/me", nil, "", c, ""), 401)
}
func TestSignupAndValidation(t *testing.T) {
	a := testApp(t)
	a.signup = true
	obj(t, req(a, "POST", "/artifacts/api/signup", map[string]string{"name": "new", "password": "initial-password"}, "", nil, ""), 201)
	c, s := login(t, a, "new")
	obj(t, req(a, "POST", "/artifacts/api/admin/users", map[string]any{"name": "admin2", "password": "initial-password", "admin": true}, "", c, s), 403)
	k := key(t, a, "new")
	obj(t, req(a, "POST", "/artifacts/api/artifacts", map[string]string{"title": "x", "kind": "exe", "visibility": "link"}, k, nil, ""), 400)
	obj(t, req(a, "POST", "/artifacts/api/signup", map[string]string{"name": "x", "password": "short"}, "", nil, ""), 400)
}

func TestRootPathAndAuthenticationHeader(t *testing.T) {
	a := testApp(t)
	a.base = ""
	w := req(a, "POST", "/api/login", map[string]string{"name": "admin", "password": "initial-password"}, "", nil, "")
	v := obj(t, w, 200)
	c := w.Result().Cookies()[0]
	issued := obj(t, req(a, "POST", "/api/keys", map[string]string{"name": "header-alias"}, "", c, v["csrf"].(string)), 201)
	r := httptest.NewRequest("GET", "/api/me", nil)
	r.Header.Set("Authentication", "Bearer "+issued["key"].(string))
	out := httptest.NewRecorder()
	a.ServeHTTP(out, r)
	obj(t, out, 200)
	for _, path := range []string{"/", "/assets/app.js"} {
		if req(a, "GET", path, nil, "", nil, "").Code != 200 {
			t.Fatal(path)
		}
	}
}

func TestArtifactOwnerName(t *testing.T) {
	a := testApp(t)
	if e := a.createUser("author", "initial-password", false); e != nil {
		t.Fatal(e)
	}
	author := key(t, a, "author")
	admin := key(t, a, "admin")
	payload := map[string]any{"title": "Owner test", "kind": "md", "content": "# Owner", "visibility": "link", "users": []string{}, "owner_name": "spoofed"}
	created := obj(t, req(a, "POST", "/artifacts/api/artifacts", payload, author, nil, ""), 201)
	id := created["id"].(string)
	if created["owner_name"] != "author" {
		t.Fatal("publish response did not use actual owner")
	}
	shared := obj(t, req(a, "GET", "/artifacts/api/share?id="+id, nil, "", nil, ""), 200)
	if shared["owner_name"] != "author" {
		t.Fatal("share response missing author")
	}
	updated := obj(t, req(a, "PUT", "/artifacts/api/artifacts/"+id, payload, admin, nil, ""), 200)
	if updated["owner_name"] != "author" || updated["owner"] != created["owner"] {
		t.Fatal("admin update changed owner")
	}
	for _, route := range []string{"/artifacts/api/artifacts", "/artifacts/api/admin/artifacts"} {
		w := req(a, "GET", route, nil, admin, nil, "")
		if route == "/artifacts/api/artifacts" {
			w = req(a, "GET", route, nil, author, nil, "")
		}
		var list []Artifact
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &list) != nil || len(list) != 1 || list[0].OwnerName != "author" {
			t.Fatal("list missing owner metadata", w.Body.String())
		}
	}
}

func TestExistingDatabaseWithUnusedSourcePathColumn(t *testing.T) {
	a := testApp(t)
	if e := a.exec("ALTER TABLE artifacts ADD COLUMN source_path TEXT NOT NULL DEFAULT ''"); e != nil {
		t.Fatal(e)
	}
	admin := key(t, a, "admin")
	created := obj(t, req(a, "POST", "/artifacts/api/artifacts", map[string]any{"title": "Existing schema", "kind": "md", "content": "# Document", "visibility": "link"}, admin, nil, ""), 201)
	if _, exists := created["source_path"]; exists {
		t.Fatal("response still exposes removed source path")
	}
	obj(t, req(a, "GET", "/artifacts/api/share?id="+created["id"].(string), nil, "", nil, ""), 200)
	if req(a, "GET", "/artifacts/api/resolve?id="+created["id"].(string), nil, admin, nil, "").Code != 404 {
		t.Fatal("obsolete resolver is still available")
	}
}
