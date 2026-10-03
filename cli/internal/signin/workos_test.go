package signin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A fake WorkOS: pending twice, then slow_down, then the result.
func TestDeviceFlow(t *testing.T) {
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/user_management/authorize/device":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["client_id"] != "client_test" || r.Header.Get("Content-Type") != "application/json" {
				w.WriteHeader(400)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"device_code": "dev-123", "user_code": "BCDF-GHJK",
				"verification_uri": "https://auth.example/device", "verification_uri_complete": "https://auth.example/device?user_code=BCDF-GHJK",
				"expires_in": 300, "interval": 5})
		case "/user_management/authenticate":
			r.ParseForm()
			if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || r.Form.Get("device_code") != "dev-123" || r.Form.Get("client_id") != "client_test" {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_request"})
				return
			}
			polls++
			w.Header().Set("Content-Type", "application/json")
			switch polls {
			case 1, 2:
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]string{"error": "authorization_pending"})
			case 3:
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]string{"error": "slow_down"})
			default:
				json.NewEncoder(w).Encode(map[string]any{"access_token": "at-secret", "refresh_token": "rt-secret",
					"user": map[string]any{"id": "user_1", "email": "pat@example.com", "first_name": "Pat"}})
			}
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "client_test")
	var waits []time.Duration
	c.Sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	d, err := c.Start(context.Background())
	if err != nil || d.UserCode != "BCDF-GHJK" {
		t.Fatalf("start: %+v %v", d, err)
	}
	r, err := c.Wait(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	if r.AccessToken != "at-secret" || r.User.Email != "pat@example.com" {
		t.Fatalf("result: %+v", r.User)
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
	for code, want := range map[string]error{"access_denied": ErrDenied, "expired_token": ErrExpired} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]string{"error": code})
		}))
		c := New(srv.URL, "client_test")
		c.Sleep = func(context.Context, time.Duration) error { return nil }
		_, err := c.Wait(context.Background(), &Device{DeviceCode: "d", Interval: 5, ExpiresIn: 300})
		srv.Close()
		if err != want {
			t.Errorf("%s: got %v", code, err)
		}
	}
}
