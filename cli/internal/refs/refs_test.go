package refs

import (
	"strings"
	"testing"
)

func TestPointerRoundTrip(t *testing.T) {
	root := t.TempDir()
	p := Pointer{Path: "research/infra/x", URL: "https://example.com/x.git", Ref: "refs/heads/main", Commit: strings.Repeat("ab", 20)}
	if err := Write(root, p); err != nil {
		t.Fatal(err)
	}
	got, err := Read(root, "research/infra/x")
	if err != nil || got != p {
		t.Fatalf("read %+v, %v", got, err)
	}
	all, err := List(root)
	if err != nil || len(all) != 1 || all[0] != p {
		t.Fatalf("list %+v, %v", all, err)
	}
}

func TestPointerRejects(t *testing.T) {
	ok := Pointer{Path: "x", URL: "https://example.com/x.git", Ref: "refs/heads/main", Commit: strings.Repeat("a", 40)}
	bad := map[string]func(*Pointer){
		"token in url": func(p *Pointer) { p.URL = "https://user:tok@example.com/x.git" },
		"short ref":    func(p *Pointer) { p.Ref = "main" },
		"short commit": func(p *Pointer) { p.Commit = "abc123" },
		"upper commit": func(p *Pointer) { p.Commit = strings.Repeat("A", 40) },
		"missing url":  func(p *Pointer) { p.URL = "" },
	}
	for name, mutate := range bad {
		p := ok
		mutate(&p)
		if p.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if ok.Validate() != nil {
		t.Fatal("a good pointer was refused")
	}
	sha256 := ok
	sha256.Commit = strings.Repeat("b", 64)
	if sha256.Validate() != nil {
		t.Fatal("a 64-character commit was refused")
	}
}

func TestLFSPointer(t *testing.T) {
	p, err := NewLFS(strings.NewReader("hello\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := "version https://git-lfs.github.com/spec/v1\noid sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03\nsize 6\n"
	if p.String() != want {
		t.Fatalf("pointer:\n%s", p.String())
	}
	if got, ok := ParseLFS([]byte(want)); !ok || got != p {
		t.Fatalf("parse: %+v %v", got, ok)
	}
	for _, s := range []string{
		strings.Replace(want, "size 6\n", "size 6", 1),                // no final newline
		strings.Replace(want, "size 6", "size 06", 1),                 // leading zero
		want + "ext-0-foo sha256:00\n",                                // extra key
		strings.Replace(want, "oid sha256:5891", "oid sha256:589", 1), // short oid
		"hello\n",
	} {
		if _, ok := ParseLFS([]byte(s)); ok {
			t.Errorf("parsed a non-pointer: %q", s)
		}
	}
}
