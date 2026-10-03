package app

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"regexp"
	"strings"
	"text/tabwriter"

	"pando/internal/config"
	"pando/internal/gitx"
	"pando/internal/server"
)

// obtainCredential is the one sign-in step. How people sign in is not
// decided (an emailed code, passkeys or WorkOS; RULINGS.md). Until it is,
// it takes a credential made on a signed-in machine with
// `pando credential create`, typed with no echo or piped in. A real sign-in
// flow replaces this function and nothing else.
func obtainCredential(e *Env, serverURL string) (string, error) {
	if !e.isTerminal() {
		return config.ReadToken(e.Stdin)
	}
	return e.readSecret("Credential for " + config.Host(serverURL) + " (input hidden): ")
}

// readBootstrap asks for the server's bootstrap secret: typed with no echo,
// or piped in. Never an argument, never printed.
func readBootstrap(e *Env, serverURL string) (string, error) {
	if !e.isTerminal() {
		return config.ReadToken(e.Stdin)
	}
	return e.readSecret("Bootstrap secret for " + config.Host(serverURL) + " (input hidden): ")
}

var loginRe = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9]|-[a-z0-9]){0,38}$`)

func (e *Env) serverURL(flagValue string) string {
	if s := strings.TrimRight(flagValue, "/"); s != "" {
		return s
	}
	if root, err := e.root(); err == nil {
		return root.Server
	}
	return e.Home.Server
}

// Login is `pando login`: sign this machine in once, like `gh auth login`.
// git (through `pando credential`) and every agent on the machine then act
// as this user.
func Login(e *Env, args []string) error {
	fs := flags("login")
	srv := fs.String("server", "", "the Pando server URL (default: ~/.pando/config.toml or PANDO_SERVER)")
	bootstrap := fs.Bool("bootstrap", false, "make your user with the server's bootstrap secret (asked for with no echo)")
	login := fs.String("login", "", "with --bootstrap: the login to make (default: your login name)")
	name := fs.String("name", "", "your name on commits (default: the account's, else git config user.name)")
	email := fs.String("email", "", "your email on commits (default: the account's, else git config user.email)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	serverURL := e.serverURL(*srv)
	if serverURL == "" {
		return UsageError{"pando login --server <url>"}
	}
	var (
		me     *server.Me
		secret string
		err    error
	)
	if *bootstrap {
		b, err := readBootstrap(e, serverURL)
		if err != nil {
			return err
		}
		if me, secret, err = makeUser(e, serverURL, b, *login, *name, *email); err != nil {
			return err
		}
	} else {
		if secret, err = obtainCredential(e, serverURL); err != nil {
			return err
		}
		s, err := server.Open(serverURL, secret)
		if err != nil {
			return err
		}
		me, err = s.Me(e.Ctx)
		if st := server.StatusOf(err); st == 401 || st == 403 {
			return errors.New("the server did not take that credential (to make your user on a new server: pando login --bootstrap)")
		} else if err != nil {
			return err
		}
	}
	return finishLogin(e, serverURL, *srv, secret, me, *name, *email)
}

// finishLogin stores the credential and who it signs in as.
func finishLogin(e *Env, serverURL, flagServer, secret string, me *server.Me, name, email string) error {
	acct := config.Account{Login: me.Login, Name: me.Name, Email: me.Email}
	if name != "" {
		acct.Name = name
	}
	if email != "" {
		acct.Email = email
	}
	if acct.Name == "" {
		acct.Name, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.name")
	}
	if acct.Email == "" {
		acct.Email, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.email")
	}
	if e.Home.Server == "" || flagServer != "" {
		e.Home.Server = serverURL
	}
	if err := e.Home.SaveCredential(serverURL, secret, acct); err != nil {
		return err
	}
	e.printf("Signed in to %s as %s (credential %q).\n", config.Host(serverURL), acct.Login, me.Credential.Name)
	e.printf("The credential is in %s, mode 600. git and agents on this machine now act as %s.\n",
		e.Home.CredentialPath(serverURL), acct.Login)
	if acct.Name != "" {
		e.printf("Commits in Pando worktrees are authored as %s.\n", who(acct))
	}
	return nil
}

// makeUser uses the bootstrap secret to make a user and this machine's first
// credential.
func makeUser(e *Env, serverURL, bootstrap, login, name, email string) (*server.Me, string, error) {
	if login == "" {
		if u, err := user.Current(); err == nil {
			login = strings.ToLower(u.Username)
		}
	}
	if !loginRe.MatchString(login) {
		return nil, "", fmt.Errorf("%q cannot be a login (lower-case letters, digits and single dashes); pass --login", login)
	}
	if name == "" {
		name, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.name")
	}
	if email == "" {
		email, _ = gitx.Cmd{}.Run(e.Ctx, "config", "--get", "user.email")
	}
	s, err := server.Open(serverURL, "")
	if err != nil {
		return nil, "", err
	}
	nu, err := s.CreateUser(e.Ctx, bootstrap, login, name, email, e.Home.Machine)
	if err != nil {
		switch {
		case server.StatusOf(err) == 401:
			return nil, "", errors.New("the server took that neither as a credential nor as its bootstrap secret")
		case server.StatusOf(err) == 409:
			return nil, "", fmt.Errorf("user %s exists; sign in with one of its credentials (make one with `pando credential create --name %s` on a signed-in machine)", login, e.Home.Machine)
		}
		return nil, "", err
	}
	if nu.Credential.Secret == "" {
		return nil, "", errors.New("the server made the user but returned no credential")
	}
	e.printf("Made user %s on %s.\n", nu.User.Login, config.Host(serverURL))
	return &server.Me{User: nu.User, Credential: nu.Credential}, nu.Credential.Secret, nil
}

func who(a config.Account) string {
	n := a.Name
	if n == "" {
		n = a.Login
	}
	if a.Email != "" {
		return fmt.Sprintf("%s <%s>", n, a.Email)
	}
	return n
}

// Logout is `pando logout`.
func Logout(e *Env, args []string) error {
	fs := flags("logout")
	srv := fs.String("server", "", "the server to sign out of (default: the configured one)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	serverURL := e.serverURL(*srv)
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
	e.printf("Signed out of %s; this machine's credential is deleted. (It still works until revoked: pando credential revoke.)\n", config.Host(serverURL))
	return nil
}

// Auth is `pando auth status`.
func Auth(e *Env, args []string) error {
	if len(args) == 0 || args[0] != "status" {
		return UsageError{"pando auth status [--server <url>]"}
	}
	fs := flags("auth status")
	srv := fs.String("server", "", "the server (default: the configured one)")
	if _, err := parse(fs, args[1:]); err != nil {
		return err
	}
	serverURL := e.serverURL(*srv)
	if serverURL == "" {
		e.printf("No server configured. Run pando login --server <url>.\n")
		return nil
	}
	e.printf("%s\n", config.Host(serverURL))
	switch _, statErr := os.Stat(e.Home.CredentialPath(serverURL)); {
	case os.Getenv("PANDO_TOKEN") != "":
		e.printf("  credential: from PANDO_TOKEN\n")
	case statErr == nil:
		st, _ := os.Stat(e.Home.CredentialPath(serverURL))
		e.printf("  credential: %s (mode %o)\n", e.Home.CredentialPath(serverURL), st.Mode().Perm())
	default:
		e.printf("  credential: none; run pando login\n")
		return nil
	}
	e.printf("  machine: %s\n", e.Home.Machine)
	if a := os.Getenv("PANDO_AGENT"); a != "" {
		e.printf("  agent: %s (commits get Pando-Agent: %s)\n", a, a)
	}
	tok, _ := e.Home.Token(serverURL)
	s, err := server.Open(serverURL, tok)
	if err != nil {
		return err
	}
	me, err := s.Me(e.Ctx)
	if err != nil {
		e.printf("  the server did not accept the credential: %v\n", err)
		return nil
	}
	e.printf("  signed in as: %s (credential %q, %s)\n", me.Login, me.Credential.Name, me.Credential.Kind)
	if acct, ok := e.Home.Account(serverURL); ok {
		e.printf("  commits authored as: %s\n", who(acct))
	}
	return nil
}

// Credential is `pando credential`. With get, store or erase it is a git
// credential helper: git asks it for the password of a Pando URL and it
// answers with this machine's credential, on its standard output to git, as
// the helper protocol requires. With create, list and revoke it manages the
// user's credentials (another machine, a cloud sandbox).
func Credential(e *Env, args []string) error {
	if len(args) == 0 {
		return UsageError{"pando credential create --name <sandbox> --out <file> | list | revoke <id>"}
	}
	switch args[0] {
	case "get":
		return credentialGet(e)
	case "store", "erase":
		_, _ = io.Copy(io.Discard, e.Stdin) // nothing is stored
		return nil
	case "create":
		return credentialCreate(e, args[1:])
	case "list", "ls":
		return credentialList(e, args[1:])
	case "revoke":
		return credentialRevoke(e, args[1:])
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
	tok, err := e.Home.Token(serverURL)
	if err != nil {
		return nil // git falls through to its other helpers, or fails
	}
	acct, _ := e.Home.Account(serverURL)
	user := acct.Login
	if user == "" {
		user = "pando"
	}
	fmt.Fprintf(e.Stdout, "username=%s\npassword=%s\n", user, tok)
	return nil
}

func (e *Env) signedIn(flagServer string) (server.Server, string, error) {
	serverURL := e.serverURL(flagServer)
	if serverURL == "" {
		return nil, "", errors.New("no server configured; run pando login --server <url>")
	}
	tok, err := e.Home.Token(serverURL)
	if err != nil {
		return nil, "", err
	}
	s, err := server.Open(serverURL, tok)
	return s, serverURL, err
}

func credentialCreate(e *Env, args []string) error {
	fs := flags("credential create")
	name := fs.String("name", "", "the machine or sandbox it is for")
	kind := fs.String("kind", "sandbox", "sandbox or machine")
	out := fs.String("out", "", "file to write the secret to (mode 600), or - for a pipe")
	srv := fs.String("server", "", "the server (default: the configured one)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	if *name == "" || *out == "" {
		return UsageError{"pando credential create --name <sandbox> --out <file | ->"}
	}
	if *out == "-" {
		if f, ok := e.Stdout.(*os.File); ok {
			if st, err := f.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
				return errors.New("--out - writes the secret to a pipe, not a terminal; pipe it (| wrangler secret put PANDO_TOKEN) or give a file")
			}
		}
	}
	s, _, err := e.signedIn(*srv)
	if err != nil {
		return err
	}
	c, err := s.CreateCredential(e.Ctx, *name, *kind)
	if err != nil {
		return err
	}
	if c.Secret == "" {
		return errors.New("the server returned no secret")
	}
	if *out == "-" {
		fmt.Fprintln(e.Stdout, c.Secret)
		fmt.Fprintf(e.Stderr, "Made credential %s (%s) for %s; the secret went to the pipe.\n", c.ID, c.Kind, c.Name)
		return nil
	}
	p := e.abs(*out)
	if err := os.WriteFile(p, []byte(c.Secret+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(p, 0o600); err != nil {
		return err
	}
	e.printf("Made credential %s (%s) for %s. Its secret is in %s, mode 600.\n", c.ID, c.Kind, c.Name, p)
	e.printf("In the sandbox, set PANDO_TOKEN from that file; it acts as you. Revoke it with: pando credential revoke %s\n", c.ID)
	return nil
}

func credentialList(e *Env, args []string) error {
	fs := flags("credential list")
	srv := fs.String("server", "", "the server (default: the configured one)")
	if _, err := parse(fs, args); err != nil {
		return err
	}
	s, _, err := e.signedIn(*srv)
	if err != nil {
		return err
	}
	cs, err := s.ListCredentials(e.Ctx)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(e.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tNAME\tKIND\tCREATED\tLAST USED")
	for _, c := range cs {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", c.ID, c.Name, c.Kind, dash(c.CreatedAt), dash(c.LastUsedAt))
	}
	return tw.Flush()
}

func credentialRevoke(e *Env, args []string) error {
	fs := flags("credential revoke")
	srv := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) != 1 {
		return UsageError{"pando credential revoke <id>"}
	}
	s, _, err := e.signedIn(*srv)
	if err != nil {
		return err
	}
	if err := s.RevokeCredential(e.Ctx, pos[0]); err != nil {
		return err
	}
	e.printf("Revoked %s.\n", pos[0])
	return nil
}
