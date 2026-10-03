package signin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func pandoError(w http.ResponseWriter, status int, code string) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": code}})
}

// A fake Pando Worker: pending twice, slow_down once, then signed in.
func TestDeviceFlow(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("sign-in calls carry no credential")
		}
		switch r.URL.Path {
		case "/v1/login/device":
			json.NewEncoder(w).Encode(map[string]any{"device_code": "dev-123", "user_code": "RRGQ-BJVS",
				"verification_uri": "https://auth.example/device", "verification_uri_complete": "https://auth.example/device?user_code=RRGQ-BJVS",
				"expires_in": 300, "interval": 5})
		case "/v1/login/token":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["device_code"] != "dev-123" || body["credential_name"] != "box1" || body["kind"] != "machine" {
				pandoError(w, 400, "invalid_request")
				return
			}
			polls++
			switch polls {
			case 1, 2:
				pandoError(w, 400, "authorization_pending")
			case 3:
				pandoError(w, 400, "slow_down")
			default:
				json.NewEncoder(w).Encode(map[string]any{
					"user":       map[string]any{"login": "pat", "email": "pat@example.com"},
					"credential": map[string]any{"id": "cred_1", "name": "box1", "kind": "machine", "secret": "pando_secret"},
					"joined":     []string{"acme"},
				})
			}
		}
	}))
	defer srv.Close()

	c := New(srv.URL)
	var waits []time.Duration
	c.Sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	d, err := c.Start(context.Background())
	if err != nil || d.UserCode != "RRGQ-BJVS" {
		t.Fatalf("start: %+v %v", d, err)
	}
	r, err := c.Wait(context.Background(), d, "box1", "machine")
	if err != nil {
		t.Fatal(err)
	}
	if r.User.Login != "pat" || r.Credential.Secret != "pando_secret" || len(r.Joined) != 1 {
		t.Fatalf("result: %+v", r)
	}
	want := []time.Duration{5 * time.Second, 5 * time.Second, 5 * time.Second, 10 * time.Second}
	if len(waits) != len(want) {
		t.Fatalf("waits %v", waits)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits %v, want %v (slow_down adds 5 s)", waits, want)
		}
	}
}

func TestDeviceFlowStops(t *testing.T) {
	for code, want := range map[string]error{"access_denied": ErrDenied, "expired_token": ErrExpired, "invalid_grant": ErrExpired} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { pandoError(w, 400, code) }))
		c := New(srv.URL)
		c.Sleep = func(context.Context, time.Duration) error { return nil }
		_, err := c.Wait(context.Background(), &Device{DeviceCode: "d", Interval: 5, ExpiresIn: 300}, "box1", "machine")
		srv.Close()
		if err != want {
			t.Errorf("%s: got %v", code, err)
		}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { pandoError(w, 503, "sign_in_not_configured") }))
	defer srv.Close()
	if _, err := New(srv.URL).Start(context.Background()); err != ErrNotConfigured {
		t.Errorf("not configured: %v", err)
	}
}
