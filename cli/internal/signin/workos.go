// Package signin signs a machine in: WorkOS AuthKit's CLI Auth, the OAuth
// device flow, run through the Pando Worker (api-v1.yaml, loginStart and
// loginPoll). The Worker holds the WorkOS client; the CLI only shows a code,
// polls, and receives the Pando user and a new machine credential. The
// credential's secret is never printed or logged.
package signin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Device is the answer to POST /v1/login/device.
type Device struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// User is the Pando user.
type User struct {
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Credential is the new machine credential; Secret is shown once.
type Credential struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Secret string `json:"secret"`
}

// Result is the answer to a successful POST /v1/login/token.
type Result struct {
	User       User       `json:"user"`
	Credential Credential `json:"credential"`
	Joined     []string   `json:"joined"`
}

// Client runs the flow against one Pando server.
type Client struct {
	Server string
	HTTP   *http.Client
	Sleep  func(context.Context, time.Duration) error // for tests
}

// New makes a client for a Pando server URL.
func New(server string) *Client {
	return &Client{Server: strings.TrimRight(server, "/"), HTTP: &http.Client{Timeout: 30 * time.Second}, Sleep: sleep}
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

// ErrNotConfigured means the server has no sign-in (no WorkOS client): use
// pando login --bootstrap on a self-hosted server.
var ErrNotConfigured = errors.New("this server has no sign-in set up; on a self-hosted server use pando login --bootstrap")

// ErrDenied means the person turned the request down.
var ErrDenied = errors.New("the sign-in was turned down")

// ErrExpired means the code ran out before the person confirmed it.
var ErrExpired = errors.New("the sign-in code expired; run pando login again")

func (c *Client) post(ctx context.Context, path string, body any) (int, []byte, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", c.Server+path, bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "pando-cli/0.1")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, data, err
}

func errorCode(data []byte) (code, message string) {
	var e struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &e)
	return e.Error.Code, e.Error.Message
}

// Start asks the server for a code to confirm in the browser.
func (c *Client) Start(ctx context.Context) (*Device, error) {
	status, data, err := c.post(ctx, "/v1/login/device", map[string]string{})
	if err != nil {
		return nil, err
	}
	if status/100 != 2 {
		code, msg := errorCode(data)
		if code == "sign_in_not_configured" {
			return nil, ErrNotConfigured
		}
		return nil, fmt.Errorf("starting sign-in: HTTP %d %s %s", status, code, msg)
	}
	d := &Device{}
	if err := json.Unmarshal(data, d); err != nil {
		return nil, err
	}
	if d.DeviceCode == "" || d.UserCode == "" {
		return nil, errors.New("starting sign-in: the server sent no code")
	}
	if d.Interval <= 0 {
		d.Interval = 5
	}
	if d.ExpiresIn <= 0 {
		d.ExpiresIn = 300
	}
	return d, nil
}

// Wait polls until the person confirms, turns it down, or the code expires.
// credentialName names the new credential (the machine name).
func (c *Client) Wait(ctx context.Context, d *Device, credentialName, kind string) (*Result, error) {
	interval := time.Duration(d.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(d.ExpiresIn) * time.Second)
	body := map[string]string{"device_code": d.DeviceCode, "credential_name": credentialName, "kind": kind}
	for {
		if err := c.Sleep(ctx, interval); err != nil {
			return nil, err
		}
		if time.Now().After(deadline) {
			return nil, ErrExpired
		}
		status, data, err := c.post(ctx, "/v1/login/token", body)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue // a network blip; try again at the next interval
		}
		if status/100 == 2 {
			r := &Result{}
			if err := json.Unmarshal(data, r); err != nil {
				return nil, err
			}
			if r.Credential.Secret == "" {
				return nil, errors.New("signed in, but the server sent no credential")
			}
			return r, nil
		}
		code, msg := errorCode(data)
		switch code {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "access_denied":
			return nil, ErrDenied
		case "expired_token", "invalid_grant":
			return nil, ErrExpired
		default:
			return nil, fmt.Errorf("sign-in: HTTP %d %s %s", status, code, msg)
		}
	}
}
