package app

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/server"
)

// obtainCredential is the one sign-in step. How people sign in is not
// decided yet (GitHub sign-in or an email link, RULINGS.md); until then it
// takes a credential typed or piped in. A browser flow replaces this
// function and nothing else.
func obtainCredential(e *Env, serverURL string) (string, error) {
	if v := os.Getenv("PANDO_LOGIN_CREDENTIAL"); v != "" {
		return strings.TrimSpace(v), nil
	}
	if !e.isTerminal() {
		return config.ReadToken(e.Stdin)
	}
	return e.readSecret("Credential for " + serverURL + " (input hidden): ")
}

// Login is `pando login`: sign this machine in once, like `gh auth login`.
// git (through `pando credential`) and every agent on the machine then act
// as this person.
func Login(e *Env, args []string) error {
	fs := flags("login")
	srv := fs.String("server", "", "the Pando server URL (default: ~/.pando/config.toml or PANDO_SERVER)")
	name := fs.String("name", "", "your name for commits (default: git config user.name)")
	email := fs.String("email", "", "your email for commits (default: git config user.email)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	serverURL := strings.TrimRight(*srv, "/")
	if serverURL == "" {
		serverURL = e.Home.Server
	}
	if serverURL == "" {
		return UsageError{"pando login --server <url>"}
	}
	cred, err := obtainCredential(e, serverURL)
	if err != nil {
		return err
	}
	acct := config.Account{Name: *name, Email: *email}
	if acct.Name == "" {
		acct.Name, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.name")
	}
	if acct.Email == "" {
		acct.Email, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.email")
	}
	if acct.Name == "" {
		return errors.New("who are you? pass --name and --email (they author your commits)")
	}
	if e.Home.Server == "" || *srv != "" {
		e.Home.Server = serverURL
	}
	if err := e.Home.SaveCredential(serverURL, cred, acct); err != nil {
		return err
	}
	e.printf("Signed in to %s as %s.\n", config.Host(serverURL), who(acct))
	e.printf("The credential is in %s (mode 600). git and agents on this machine now act as you.\n", e.Home.CredentialPath(serverURL))
	return nil
}

func who(a config.Account) string {
	if a.Email != "" {
		return fmt.Sprintf("%s <%s>", a.Name, a.Email)
	}
	return a.Name
}

// Logout is `pando logout`.
func Logout(e *Env, args []string) error {
	fs := flags("logout")
	srv := fs.String("server", "", "the server to sign out of (default: the configured one)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	serverURL := strings.TrimRight(*srv, "/")
	if serverURL == "" {
		serverURL = e.Home.Server
	}
	if serverURL == "" {
		return UsageError{"pando logout --server <url>"}
	}
	removed, err := e.Home.Logout(serverURL)
	if err != nil {
		return err
	}
	if !removed {
		e.printf("Not signed in to %s.\n", config.Host(serverURL))
		return nil
	}
	e.printf("Signed out of %s; its credential is deleted from this machine.\n", config.Host(serverURL))
	return nil
}

// Auth is `pando auth status`.
func Auth(e *Env, args []string) error {
	if len(args) == 0 || args[0] != "status" {
		return UsageError{"pando auth status"}
	}
	serverURL := e.Home.Server
	mono := ""
	if root, err := e.root(); err == nil {
		serverURL, mono = root.Server, root.Name
	}
	if serverURL == "" {
		e.printf("No server configured. Run pando login --server <url>.\n")
		return nil
	}
	host := config.Host(serverURL)
	e.printf("%s\n", host)
	acct, signedIn := e.Home.Account(serverURL)
	_, credErr := os.Stat(e.Home.CredentialPath(serverURL))
	switch {
	case os.Getenv("PANDO_TOKEN") != "":
		e.printf("  credential: from PANDO_TOKEN\n")
	case credErr == nil:
		st, _ := os.Stat(e.Home.CredentialPath(serverURL))
		e.printf("  credential: %s (mode %o)\n", e.Home.CredentialPath(serverURL), st.Mode().Perm())
	default:
		e.printf("  credential: none; run pando login\n")
	}
	if signedIn {
		e.printf("  signed in as: %s\n", who(acct))
	}
	e.printf("  machine: %s\n", e.Home.Machine)
	if a := os.Getenv("PANDO_AGENT"); a != "" {
		e.printf("  agent: %s (commits get Pando-Agent: %s)\n", a, a)
	}
	if mono != "" {
		tok, err := e.Home.Token(serverURL, mono)
		if err != nil && !strings.HasPrefix(serverURL, "file://") {
			e.printf("  %s: no credential\n", mono)
			return nil
		}
		s, err := server.Open(serverURL, tok)
		if err != nil {
			return err
		}
		me, err := s.Me(e.Ctx, mono)
		if err != nil {
			e.printf("  %s: the server did not accept the credential (%v)\n", mono, err)
			return nil
		}
		e.printf("  %s: the server knows you as %s (%s)\n", mono, me.Name, me.Role)
	}
	return nil
}

// Credential is `pando credential`. With get, store or erase it is a git
// credential helper: git asks it for the password of a Pando URL and it
// answers with this machine's credential. It prints the credential only to
// git, on its standard output, as the helper protocol requires.
func Credential(e *Env, args []string) error {
	if len(args) == 0 {
		return UsageError{"pando credential get | create --name <sandbox>"}
	}
	switch args[0] {
	case "get":
		return credentialGet(e)
	case "store", "erase":
		_, _ = bufio.NewReader(e.Stdin).ReadString(0) // nothing is stored
		return nil
	case "create":
		return errors.New("pando credential create needs the users and credentials API (api-v1.yaml update pending)")
	}
	return UsageError{"unknown credential command " + args[0]}
}

func credentialGet(e *Env) error {
	kv := map[string]string{}
	sc := bufio.NewScanner(e.Stdin)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[k] = v
		}
	}
	if kv["protocol"] == "" || kv["host"] == "" {
		return nil
	}
	serverURL := kv["protocol"] + "://" + kv["host"]
	mono, _, _ := strings.Cut(strings.TrimPrefix(kv["path"], "/"), "/")
	tok, err := e.Home.Token(serverURL, mono)
	if err != nil {
		return nil // git falls through to its other helpers or fails
	}
	acct, _ := e.Home.Account(serverURL)
	user := acct.Name
	if user == "" {
		user = "pando"
	}
	fmt.Fprintf(e.Stdout, "username=%s\npassword=%s\n", user, tok)
	return nil
}
