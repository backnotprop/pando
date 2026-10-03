package meta

// Large files and binaries (M7): their bytes go to R2 through the Worker
// under their SHA-256, and the meta layer carries a Git LFS pointer
// (formats.md, section 5; meta-sync.md, "Large files and binaries").

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"
)

// MaxLarge is the largest file the meta layer carries through R2: 100 MB,
// the largest request body a Worker accepts. Larger files stay local.
const MaxLarge = 100 * 1024 * 1024

var pointerRE = regexp.MustCompile(`^version https://git-lfs\.github\.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]{0,15})\n$`)

// Pointer is a parsed Git LFS pointer.
type Pointer struct {
	Oid  string
	Size int64
}

// parsePointer returns the pointer when b is exactly one (under 1024 bytes).
func parsePointer(b []byte) (Pointer, bool) {
	if len(b) >= 1024 {
		return Pointer{}, false
	}
	m := pointerRE.FindSubmatch(b)
	if m == nil {
		return Pointer{}, false
	}
	n, err := strconv.ParseInt(string(m[2]), 10, 64)
	if err != nil {
		return Pointer{}, false
	}
	return Pointer{Oid: string(m[1]), Size: n}, true
}

func (p Pointer) text() []byte {
	return []byte(fmt.Sprintf("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", p.Oid, p.Size))
}

// sha256File hashes a file without reading it all into memory.
func sha256File(abs string) (string, int64, error) {
	f, err := os.Open(abs)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func (c *Client) blobURL(oid string) string {
	return c.Server + "/v1/monorepos/" + url.PathEscape(c.Monorepo) + "/meta/blobs/" + oid
}

func (c *Client) blobRequest(ctx context.Context, method, oid string, body io.Reader, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.blobURL(oid), body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = size
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return c.blobHTTP().Do(req)
}

// Large transfers get no overall timeout; ctx ends them.
func (c *Client) blobHTTP() *http.Client { return &http.Client{} }

// UploadFile sends a file's bytes to R2 unless they are there already. It
// returns the pointer and the file's size and mtime as uploaded; if the file
// changed while it was read, it fails and the caller tries again later.
func (c *Client) UploadFile(ctx context.Context, abs string) (Pointer, os.FileInfo, error) {
	before, err := os.Stat(abs)
	if err != nil {
		return Pointer{}, nil, err
	}
	oid, size, err := sha256File(abs)
	if err != nil {
		return Pointer{}, nil, err
	}
	ptr := Pointer{Oid: oid, Size: size}
	resp, err := c.blobRequest(ctx, http.MethodHead, oid, nil, 0)
	if err != nil {
		return ptr, nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		f, err := os.Open(abs)
		if err != nil {
			return ptr, nil, err
		}
		resp, err = c.blobRequest(ctx, http.MethodPut, oid, f, size)
		f.Close()
		if err != nil {
			return ptr, nil, err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return ptr, nil, fmt.Errorf("upload of %s: %d %s", filepath.Base(abs), resp.StatusCode, body)
		}
	}
	after, err := os.Stat(abs)
	if err != nil {
		return ptr, nil, err
	}
	if after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return ptr, nil, errors.New("the file changed while it was uploading")
	}
	return ptr, after, nil
}

// DownloadTo fetches a blob into a temporary file beside abs, checks its
// SHA-256, and returns the temporary file's path. The caller renames it.
func (c *Client) DownloadTo(ctx context.Context, ptr Pointer, abs string) (string, error) {
	resp, err := c.blobRequest(ctx, http.MethodGet, ptr.Oid, nil, 0)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download of %s: server answered %d", ptr.Oid[:12], resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), "."+filepath.Base(abs)+".pando-tmp-*")
	if err != nil {
		return "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
	cerr := tmp.Close()
	if err == nil {
		err = cerr
	}
	if err == nil && (n != ptr.Size || hex.EncodeToString(h.Sum(nil)) != ptr.Oid) {
		err = fmt.Errorf("download of %s: the bytes do not match the pointer", ptr.Oid[:12])
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Lstat(abs); err == nil && info.Mode().IsRegular() {
		mode = info.Mode().Perm()
	}
	os.Chmod(tmp.Name(), mode)
	return tmp.Name(), nil
}

// Fetch replaces pointer files at the given meta layer paths with their
// bytes (pando fetch, on a clone made with --text-only).
func Fetch(ctx context.Context, root string, paths []string, out io.Writer) error {
	cfg, err := LoadConfig(root)
	if err != nil {
		return err
	}
	if err := cfg.check(); err != nil {
		return err
	}
	c := NewClient(cfg)
	var failed error
	for _, rel := range paths {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Stat(abs)
		if err != nil {
			failed = err
			fmt.Fprintf(out, "%s: %v\n", rel, err)
			continue
		}
		var ptr Pointer
		ok := false
		if info.Size() < 1024 {
			b, err := os.ReadFile(abs)
			if err == nil {
				ptr, ok = parsePointer(b)
			}
		}
		if !ok {
			fmt.Fprintf(out, "%s is already here\n", rel)
			continue
		}
		start := time.Now()
		tmp, err := c.DownloadTo(ctx, ptr, abs)
		if err == nil {
			err = os.Rename(tmp, abs)
		}
		if err != nil {
			failed = err
			fmt.Fprintf(out, "%s: %v\n", rel, err)
			continue
		}
		fmt.Fprintf(out, "fetched %s (%d bytes, %s)\n", rel, ptr.Size, time.Since(start).Round(time.Millisecond))
	}
	return failed
}
