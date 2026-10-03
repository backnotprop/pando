// Package signin is how a person signs a machine in: WorkOS CLI Auth, the
// OAuth device flow (https://workos.com/docs/reference/authkit/cli-auth).
// The CLI is a public client: it holds a client ID, never an API key. The
// WorkOS result goes to the Pando Worker, which issues the machine
// credential. Tokens are never printed or logged.
package signin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultAPI is WorkOS's API. PANDO_WORKOS_API overrides it (tests).
const DefaultAPI = "https://api.workos.com"

// Device is the answer to the device authorization request.
type Device struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// User is the WorkOS user in the result.
type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

// Result is what a finished sign-in returns. AccessToken and RefreshToken
// are secrets.
type Result struct {
	User                 User   `json:"user"`
	OrganizationID       string `json:"organization_id"`
	AccessToken          string `json:"access_token"`
	RefreshToken         string `json:"refresh_token"`
	AuthenticationMethod string `json:"authentication_method"`
}

// Client runs the device flow.
type Client struct {
	API      string // WorkOS API base
	ClientID string
	HTTP     *http.Client
	Sleep    func(context.Context, time.Duration) error // for tests
}

// New makes a client for a WorkOS client ID.
func New(api, clientID string) *Client {
	if api == "" {
		api = DefaultAPI
	}
	return &Client{API: strings.TrimRight(api, "/"), ClientID: clientID, HTTP: &http.Client{Timeout: 30 * time.Second}, Sleep: sleep}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Start asks WorkOS for a device code and the URL the person opens.
func (c *Client) Start(ctx context.Context) (*Device, error) {
	body, _ := json.Marshal(map[string]string{"client_id": c.ClientID})
	req, err := http.NewRequestWithContext(ctx, "POST", c.API+"/user_management/authorize/device", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("WorkOS device authorization: HTTP %d %s", resp.StatusCode, oauthError(data))
	}
	d := &Device{}
	if err := json.Unmarshal(data, d); err != nil {
		return nil, err
	}
	if d.DeviceCode == "" || d.UserCode == "" {
		return nil, errors.New("WorkOS device authorization: no device code in the answer")
	}
	if d.Interval <= 0 {
		d.Interval = 5
	}
	if d.ExpiresIn <= 0 {
		d.ExpiresIn = 300
	}
	return d, nil
}

// ErrDenied means the person turned the request down.
var ErrDenied = errors.New("the sign-in was turned down")

// ErrExpired means the code ran out before the person finished.
var ErrExpired = errors.New("the sign-in code expired; run pando login again")

// Wait polls until the person finishes in the browser, turns it down, or
// the code expires.
func (c *Client) Wait(ctx context.Context, d *Device) (*Result, error) {
	interval := time.Duration(d.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(d.ExpiresIn) * time.Second)
	for {
		if err := c.Sleep(ctx, interval); err != nil {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, ErrExpired
		}
		form := url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {d.DeviceCode},
			"client_id":   {c.ClientID},
		}
		req, err := http.NewRequestWithContext(ctx, "POST", c.API+"/user_management/authenticate", strings.NewReader(form.Encode()))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := c.HTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue // a network blip; try again at the next interval
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if resp.StatusCode/100 == 2 {
			r := &Result{}
			if err := json.Unmarshal(data, r); err != nil {
				return nil, err
			}
			if r.AccessToken == "" {
				return nil, errors.New("WorkOS returned no access token")
			}
			return r, nil
		}
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		switch e.Error {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return nil, ErrDenied
		case "expired_token":
			return nil, ErrExpired
		default:
			return nil, fmt.Errorf("WorkOS sign-in: HTTP %d %s", resp.StatusCode, oauthError(data))
		}
	}
}

func oauthError(data []byte) string {
	var e struct {
		Error       string `json:"error"`
		Description string `json:"error_description"`
		Message     string `json:"message"`
	}
	if json.Unmarshal(data, &e) == nil {
		switch {
		case e.Error != "" && e.Description != "":
			return e.Error + ": " + e.Description
		case e.Error != "":
			return e.Error
		case e.Message != "":
			return e.Message
		}
	}
	return ""
}
