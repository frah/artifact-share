package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

//go:embed web/*
var assets embed.FS

type App struct {
	auth   CredentialAuthenticator
	db     *sql.DB
	pg     bool
	base   string
	secure bool
	signup bool
}

// CredentialAuthenticator can be replaced by an LDAP adapter. It must return a
// locally provisioned user so artifact ownership and recipient IDs remain stable.
type CredentialAuthenticator interface {
	Authenticate(name, password string) (User, error)
}
type LocalAuthenticator struct{ app *App }

func (l LocalAuthenticator) Authenticate(name, password string) (User, error) {
	var u User
	var pw string
	var admin int
	e := l.app.row("SELECT id,name,password,admin FROM users WHERE name=?", name).Scan(&u.ID, &u.Name, &pw, &admin)
	if e != nil || bcrypt.CompareHashAndPassword([]byte(pw), []byte(password)) != nil {
		return User{}, errors.New("invalid credentials")
	}
	u.Admin = admin == 1
	return u, nil
}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Admin bool   `json:"admin"`
}
type Artifact struct {
	ID         string   `json:"id"`
	Owner      string   `json:"owner"`
	Title      string   `json:"title"`
	Kind       string   `json:"kind"`
	Content    string   `json:"content"`
	Visibility string   `json:"visibility"`
	Users      []string `json:"users"`
	Updated    string   `json:"updated"`
	URL        string   `json:"url"`
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func hash(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func (a *App) q(s string) string {
	if !a.pg {
		return s
	}
	n := 0
	return replace(s, &n)
}
func replace(s string, n *int) string {
	for strings.Contains(s, "?") {
		*n++
		s = strings.Replace(s, "?", fmt.Sprintf("$%d", *n), 1)
	}
	return s
}
func (a *App) exec(q string, args ...any) error   { _, e := a.db.Exec(a.q(q), args...); return e }
func (a *App) row(q string, args ...any) *sql.Row { return a.db.QueryRow(a.q(q), args...) }
func send(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, msg string) {
	send(w, status, map[string]string{"error": msg})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid JSON or body exceeds 10 MiB")
		return false
	}
	return true
}
func (a *App) user(r *http.Request) (User, bool, bool) {
	var u User
	var admin int
	var e error
	api := false
	auth := r.Header.Get("Authorization")
	if auth == "" {
		auth = r.Header.Get("Authentication")
	}
	if auth != "" {
		api = true
		key := strings.TrimPrefix(auth, "Bearer ")
		e = a.row("SELECT u.id,u.name,u.admin FROM users u JOIN api_keys k ON k.user_id=u.id WHERE k.digest=?", hash(key)).Scan(&u.ID, &u.Name, &admin)
	} else {
		c, err := r.Cookie("artifact_session")
		if err != nil {
			return u, false, false
		}
		e = a.row("SELECT u.id,u.name,u.admin FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.digest=? AND s.expires>?", hash(c.Value), time.Now().Unix()).Scan(&u.ID, &u.Name, &admin)
	}
	u.Admin = admin == 1
	return u, e == nil, api
}
func (a *App) createUser(name, password string, admin bool) error {
	name = strings.TrimSpace(name)
	if len(name) < 1 || len(name) > 80 || len(password) < 8 || len(password) > 72 {
		return errors.New("name is required; password must contain 8–72 bytes")
	}
	b, e := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if e != nil {
		return e
	}
	flag := 0
	if admin {
		flag = 1
	}
	return a.exec("INSERT INTO users(id,name,password,admin) VALUES(?,?,?,?)", token(), name, string(b), flag)
}
func (a *App) artifact(id string) (Artifact, error) {
	var v Artifact
	var users string
	e := a.row("SELECT id,owner,title,kind,content,visibility,recipients,updated FROM artifacts WHERE id=?", id).Scan(&v.ID, &v.Owner, &v.Title, &v.Kind, &v.Content, &v.Visibility, &users, &v.Updated)
	json.Unmarshal([]byte(users), &v.Users)
	v.URL = a.base + "/s/" + v.ID
	return v, e
}
func allowed(v Artifact, u User, logged bool) bool {
	if v.Visibility == "link" {
		return true
	}
	if !logged {
		return false
	}
	if u.ID == v.Owner || u.Admin {
		return true
	}
	for _, id := range v.Users {
		if id == u.ID {
			return true
		}
	}
	return false
}
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-store")
	p := r.URL.Path
	if p == "/healthz" {
		if e := a.db.PingContext(r.Context()); e != nil {
			fail(w, 503, "database unavailable")
		} else {
			send(w, 200, map[string]string{"status": "ok"})
		}
		return
	}
	if a.base != "" {
		if p == a.base {
			http.Redirect(w, r, a.base+"/", 302)
			return
		}
		if !strings.HasPrefix(p, a.base+"/") {
			http.NotFound(w, r)
			return
		}
		p = strings.TrimPrefix(p, a.base)
	}
	u, logged, api := a.user(r)
	if r.Method != "GET" && r.Method != "HEAD" && logged && !api {
		c, e := r.Cookie("artifact_session")
		if e != nil || r.Header.Get("X-CSRF-Token") != c.Value {
			fail(w, 403, "CSRF token required")
			return
		}
	}
	if p == "/api/login" && r.Method == "POST" {
		var in struct {
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if !decode(w, r, &in) {
			return
		}
		var e error
		u, e = a.auth.Authenticate(in.Name, in.Password)
		if e != nil {
			fail(w, 401, "invalid credentials")
			return
		}
		s := token()
		if e = a.exec("INSERT INTO sessions(digest,user_id,expires) VALUES(?,?,?)", hash(s), u.ID, time.Now().Add(24*time.Hour).Unix()); e != nil {
			fail(w, 500, "cannot create session")
			return
		}
		a.exec("DELETE FROM sessions WHERE expires<?", time.Now().Unix())
		http.SetCookie(w, &http.Cookie{Name: "artifact_session", Value: s, Path: a.base + "/", HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
		send(w, 200, map[string]string{"csrf": s})
		return
	}
	if p == "/api/signup" && r.Method == "POST" && a.signup {
		var in struct {
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if !decode(w, r, &in) {
			return
		}
		if e := a.createUser(in.Name, in.Password, false); e != nil {
			fail(w, 400, "invalid name/password or name already exists")
			return
		}
		send(w, 201, map[string]bool{"ok": true})
		return
	}
	if strings.HasPrefix(p, "/s/") {
		id := strings.TrimPrefix(p, "/s/")
		raw := strings.HasSuffix(id, "/raw")
		id = strings.TrimSuffix(id, "/raw")
		if !raw {
			a.index(w)
			return
		}
		v, e := a.artifact(id)
		if e != nil || !allowed(v, u, logged) {
			http.NotFound(w, r)
			return
		}
		if raw {
			w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https: http:; font-src https: data:; connect-src https: http:")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(v.Content))
			return
		}
		a.index(w)
		return
	}
	if !strings.HasPrefix(p, "/api/") {
		if strings.HasPrefix(p, "/assets/") {
			sub, _ := fs.Sub(assets, "web")
			http.StripPrefix(a.base+"/assets/", http.FileServer(http.FS(sub))).ServeHTTP(w, r)
			return
		}
		if p == "/" {
			a.index(w)
			return
		}
		http.NotFound(w, r)
		return
	}
	if p == "/api/config" && r.Method == "GET" {
		send(w, 200, map[string]any{"signup": a.signup, "base": a.base})
		return
	}
	if p == "/api/share" && r.Method == "GET" {
		v, e := a.artifact(r.URL.Query().Get("id"))
		if e != nil || !allowed(v, u, logged) {
			fail(w, 404, "artifact not found or access denied")
			return
		}
		send(w, 200, v)
		return
	}
	if !logged {
		fail(w, 401, "authentication required")
		return
	}
	if p == "/api/me" && r.Method == "GET" {
		csrf := ""
		if c, e := r.Cookie("artifact_session"); e == nil {
			csrf = c.Value
		}
		send(w, 200, map[string]any{"user": u, "csrf": csrf})
		return
	}
	if p == "/api/logout" && r.Method == "POST" {
		if c, e := r.Cookie("artifact_session"); e == nil {
			a.exec("DELETE FROM sessions WHERE digest=?", hash(c.Value))
		}
		http.SetCookie(w, &http.Cookie{Name: "artifact_session", Value: "", Path: a.base + "/", MaxAge: -1, HttpOnly: true, Secure: a.secure, SameSite: http.SameSiteLaxMode})
		send(w, 200, map[string]bool{"ok": true})
		return
	}
	if p == "/api/users" && r.Method == "GET" {
		a.list(w, "SELECT id,name,admin FROM users", "users")
		return
	}
	if p == "/api/admin/users" {
		if !u.Admin {
			fail(w, 403, "admin required")
			return
		}
		if r.Method == "GET" {
			a.list(w, "SELECT id,name,admin FROM users", "users")
			return
		}
		if r.Method == "POST" {
			var in struct {
				Name     string `json:"name"`
				Password string `json:"password"`
				Admin    bool   `json:"admin"`
			}
			if !decode(w, r, &in) {
				return
			}
			if e := a.createUser(in.Name, in.Password, in.Admin); e != nil {
				fail(w, 400, "invalid name/password or name already exists")
				return
			}
			send(w, 201, map[string]bool{"ok": true})
			return
		}
	}
	if strings.HasPrefix(p, "/api/admin/users/") && r.Method == "PATCH" {
		if !u.Admin {
			fail(w, 403, "admin required")
			return
		}
		id := strings.TrimPrefix(p, "/api/admin/users/")
		var in struct {
			Password string `json:"password"`
		}
		if !decode(w, r, &in) {
			return
		}
		if len(in.Password) < 8 || len(in.Password) > 72 {
			fail(w, 400, "password must contain 8–72 bytes")
			return
		}
		pw, _ := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
		result, e := a.db.Exec(a.q("UPDATE users SET password=? WHERE id=?"), string(pw), id)
		if e != nil {
			fail(w, 500, "update failed")
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			fail(w, 404, "user not found")
			return
		}
		a.exec("DELETE FROM sessions WHERE user_id=?", id)
		send(w, 200, map[string]bool{"ok": true})
		return
	}
	if p == "/api/keys" {
		if r.Method == "GET" {
			a.list(w, "SELECT id,name,created FROM api_keys WHERE user_id=?", "keys", u.ID)
			return
		}
		if r.Method == "POST" {
			var in struct {
				Name string `json:"name"`
			}
			if !decode(w, r, &in) {
				return
			}
			if strings.TrimSpace(in.Name) == "" {
				fail(w, 400, "name required")
				return
			}
			key := "ash_" + token()
			id := token()
			if e := a.exec("INSERT INTO api_keys(id,user_id,name,digest,created) VALUES(?,?,?,?,?)", id, u.ID, in.Name, hash(key), time.Now().UTC().Format(time.RFC3339)); e != nil {
				fail(w, 500, "cannot create key")
				return
			}
			send(w, 201, map[string]string{"id": id, "key": key})
			return
		}
	}
	if strings.HasPrefix(p, "/api/keys/") && r.Method == "DELETE" {
		if e := a.exec("DELETE FROM api_keys WHERE id=? AND user_id=?", strings.TrimPrefix(p, "/api/keys/"), u.ID); e != nil {
			fail(w, 500, "delete failed")
			return
		}
		send(w, 200, map[string]bool{"ok": true})
		return
	}
	if p == "/api/artifacts" && r.Method == "GET" {
		a.list(w, "SELECT id,title,kind,visibility,updated FROM artifacts WHERE owner=? ORDER BY updated DESC", "artifacts", u.ID)
		return
	}
	if p == "/api/admin/artifacts" && r.Method == "GET" && u.Admin {
		a.list(w, "SELECT id,title,kind,visibility,updated FROM artifacts ORDER BY updated DESC", "artifacts")
		return
	}
	if p == "/api/artifacts" && r.Method == "POST" || strings.HasPrefix(p, "/api/artifacts/") && r.Method == "PUT" {
		var v Artifact
		if !decode(w, r, &v) {
			return
		}
		if v.Kind != "html" && v.Kind != "md" {
			fail(w, 400, "kind must be html or md")
			return
		}
		if v.Visibility != "link" && v.Visibility != "users" {
			fail(w, 400, "visibility must be link or users")
			return
		}
		if strings.TrimSpace(v.Title) == "" {
			fail(w, 400, "title required")
			return
		}
		for _, id := range v.Users {
			var exists string
			if a.row("SELECT id FROM users WHERE id=?", id).Scan(&exists) != nil {
				fail(w, 400, "unknown recipient")
				return
			}
		}
		recipients, _ := json.Marshal(v.Users)
		v.Owner = u.ID
		v.Updated = time.Now().UTC().Format(time.RFC3339Nano)
		var e error
		if r.Method == "POST" {
			v.ID = token()
			e = a.exec("INSERT INTO artifacts(id,owner,title,kind,content,visibility,recipients,updated) VALUES(?,?,?,?,?,?,?,?)", v.ID, v.Owner, v.Title, v.Kind, v.Content, v.Visibility, string(recipients), v.Updated)
		} else {
			v.ID = strings.TrimPrefix(p, "/api/artifacts/")
			old, err := a.artifact(v.ID)
			if err != nil {
				fail(w, 404, "artifact not found")
				return
			}
			if old.Owner != u.ID && !u.Admin {
				fail(w, 403, "owner required")
				return
			}
			v.Owner = old.Owner
			e = a.exec("UPDATE artifacts SET title=?,kind=?,content=?,visibility=?,recipients=?,updated=? WHERE id=?", v.Title, v.Kind, v.Content, v.Visibility, string(recipients), v.Updated, v.ID)
		}
		if e != nil {
			fail(w, 500, "save failed")
			return
		}
		v.URL = a.base + "/s/" + v.ID
		status := 200
		if r.Method == "POST" {
			status = 201
		}
		send(w, status, v)
		return
	}
	if strings.HasPrefix(p, "/api/artifacts/") {
		v, e := a.artifact(strings.TrimPrefix(p, "/api/artifacts/"))
		if e != nil {
			fail(w, 404, "artifact not found")
			return
		}
		if v.Owner != u.ID && !u.Admin {
			fail(w, 403, "owner required")
			return
		}
		if r.Method == "GET" {
			send(w, 200, v)
			return
		}
		if r.Method == "DELETE" {
			if e = a.exec("DELETE FROM artifacts WHERE id=?", v.ID); e != nil {
				fail(w, 500, "delete failed")
				return
			}
			send(w, 200, map[string]bool{"ok": true})
			return
		}
	}
	fail(w, 404, "endpoint not found")
}
func (a *App) index(w http.ResponseWriter) {
	b, _ := assets.ReadFile("web/index.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(strings.ReplaceAll(string(b), "{{BASE}}", a.base)))
}
func (a *App) list(w http.ResponseWriter, q, kind string, args ...any) {
	rows, e := a.db.Query(a.q(q), args...)
	if e != nil {
		fail(w, 500, "query failed")
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		switch kind {
		case "users":
			var u User
			var admin int
			if e = rows.Scan(&u.ID, &u.Name, &admin); e == nil {
				u.Admin = admin == 1
				out = append(out, u)
			}
		case "keys":
			var id, name, created string
			if e = rows.Scan(&id, &name, &created); e == nil {
				out = append(out, map[string]string{"id": id, "name": name, "created": created})
			}
		default:
			var v Artifact
			if e = rows.Scan(&v.ID, &v.Title, &v.Kind, &v.Visibility, &v.Updated); e == nil {
				v.URL = a.base + "/s/" + v.ID
				out = append(out, v)
			}
		}
		if e != nil {
			fail(w, 500, "scan failed")
			return
		}
	}
	if rows.Err() != nil {
		fail(w, 500, "query failed")
		return
	}
	send(w, 200, out)
}
func newApp() (*App, error) {
	dsn := env("DATABASE_URL", "file:artifacts.db")
	driver := "sqlite"
	pg := strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://")
	if pg {
		driver = "pgx"
	}
	db, e := sql.Open(driver, dsn)
	if e != nil {
		return nil, e
	}
	if !pg {
		db.SetMaxOpenConns(1)
		if _, e = db.Exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;"); e != nil {
			return nil, e
		}
	}
	base := strings.TrimRight(env("BASE_PATH", ""), "/")
	if base != "" && (!strings.HasPrefix(base, "/") || strings.ContainsAny(base, "<>'\"?# ") || strings.Contains(base, "..")) {
		return nil, errors.New("invalid BASE_PATH")
	}
	a := &App{db: db, pg: pg, base: base, secure: env("COOKIE_SECURE", "false") == "true", signup: env("ALLOW_SIGNUP", "false") == "true"}
	for _, q := range []string{
		"CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0)",
		"CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires BIGINT NOT NULL)",
		"CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,created TEXT NOT NULL)",
		"CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,visibility TEXT NOT NULL,recipients TEXT NOT NULL,updated TEXT NOT NULL)",
		"CREATE INDEX IF NOT EXISTS artifacts_owner ON artifacts(owner)",
	} {
		if e = a.exec(q); e != nil {
			return nil, e
		}
	}
	a.auth = LocalAuthenticator{app: a}
	var count int
	if e = a.row("SELECT COUNT(*) FROM users").Scan(&count); e != nil {
		return nil, e
	}
	if count == 0 {
		pw := os.Getenv("ADMIN_PASSWORD")
		if pw == "" {
			return nil, errors.New("ADMIN_PASSWORD (8–72 bytes) is required on first start")
		}
		if e = a.createUser(env("ADMIN_USER", "admin"), pw, true); e != nil {
			return nil, e
		}
	}
	return a, nil
}
func main() {
	a, e := newApp()
	if e != nil {
		log.Fatal(e)
	}
	defer a.db.Close()
	port := env("PORT", "8080")
	if _, e = strconv.Atoi(port); e != nil {
		log.Fatal("invalid PORT")
	}
	s := &http.Server{Addr: ":" + port, Handler: a, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Shutdown(c)
	}()
	log.Printf("Artifact Share listening on %s%s", s.Addr, a.base)
	if e = s.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
