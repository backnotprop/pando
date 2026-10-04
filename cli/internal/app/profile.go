package app

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"pando/internal/server"
)

const profileUsage = "pando profile [<login>] [--json]"

// Profile is `pando profile`: a person's profile (yours by default), its
// contribution graph for the last year drawn in the terminal, and its
// months. --json prints the contributions as the API sent them. You see
// only work in repositories you can open.
func Profile(e *Env, args []string) error {
	fs := flags("profile")
	asJSON := fs.Bool("json", false, "print the contributions as the API sent them")
	srvFlag := fs.String("server", "", "the server (default: the configured one)")
	pos, err := parse(fs, args)
	if err != nil {
		return err
	}
	if len(pos) > 1 {
		return UsageError{profileUsage}
	}
	srv, _, err := e.signedIn(*srvFlag)
	if err != nil {
		return err
	}
	h, ok := srv.(*server.HTTP)
	if !ok {
		return errors.New("profiles need a Pando server; this one is a local file:// server")
	}
	login := ""
	if len(pos) == 1 {
		login = strings.ToLower(pos[0])
	} else {
		me, err := h.Me(e.Ctx)
		if err != nil {
			return err
		}
		login = me.Login
	}
	p, err := h.Owner(e.Ctx, login)
	if err != nil {
		return err
	}
	if p.Type == "org" {
		return fmt.Errorf("%s is an organization; see it with pando org view %s", login, login)
	}
	_, offset := time.Now().Zone()
	c, err := h.Contributions(e.Ctx, login, offset/60)
	if err != nil {
		return err
	}
	if *asJSON {
		return e.printJSON(c.JSON)
	}
	printHeader(e, p)
	e.printf("\n%s in the last year\n", counted(c.Total, "contribution", "contributions"))
	for _, line := range graphLines(c) {
		e.printf("%s\n", strings.TrimRight(line, " "))
	}
	e.printf("\n")
	for _, m := range c.Months {
		e.printf("%-16s %s\n", monthName(m.Period), monthSummary(m))
	}
	return nil
}

func printHeader(e *Env, p *server.Profile) {
	if p.Name != "" {
		e.printf("%s  %s\n", p.Name, p.Login)
	} else {
		e.printf("%s\n", p.Login)
	}
	var facts []string
	if p.Bio != "" {
		facts = append(facts, p.Bio)
	}
	if p.Location != "" {
		facts = append(facts, p.Location)
	}
	for _, l := range p.Links {
		if u, err := url.Parse(l); err == nil && u.Host != "" {
			facts = append(facts, strings.TrimSuffix(u.Host+u.Path, "/"))
		}
	}
	if t, err := time.Parse(time.RFC3339, p.CreatedAt); err == nil {
		facts = append(facts, "joined "+t.Format("Jan 2, 2006"))
	}
	for _, o := range p.Orgs {
		facts = append(facts, o.Login)
	}
	e.printf("%s\n", strings.Join(facts, "  ·  "))
}

// counted is "1,206 contributions", "1 contribution".
func counted(n int, one, many string) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if n == 1 {
		return s + " " + one
	}
	return s + " " + many
}

// graphSteps are the graph's five steps in the terminal: no work, then the
// four levels the API sends (the quartiles of the person's own busy days).
var graphSteps = []string{"·", "░", "▒", "▓", "█"}

// graphLines draws the graph: month names on top, then a row per weekday
// (Sunday first, Mon, Wed and Fri named), one column per week.
func graphLines(c *server.Contributions) []string {
	from, err1 := time.Parse("2006-01-02", c.From)
	to, err2 := time.Parse("2006-01-02", c.To)
	if err1 != nil || err2 != nil {
		return nil
	}
	n := map[string]int{}
	for _, d := range c.Days {
		n[d.Date] = d.N
	}
	days := int(to.Sub(from).Hours()/24) + 1
	weeks := (days + 6) / 7
	rows := make([][]string, 7)
	for i := range rows {
		rows[i] = make([]string, weeks)
		for w := range rows[i] {
			rows[i][w] = " "
		}
	}
	for i := 0; i < days; i++ {
		d := from.AddDate(0, 0, i)
		step := 0
		for l, min := range c.Levels {
			if n[d.Format("2006-01-02")] >= min {
				step = l + 1
			}
		}
		rows[i%7][i/7] = graphSteps[step]
	}
	// A month's name over its first column; the first is left out when the next would crowd it.
	type label struct {
		col  int
		name string
	}
	var labels []label
	for w := 0; w < weeks; w++ {
		m := from.AddDate(0, 0, 7*w).Format("Jan")
		if len(labels) == 0 || labels[len(labels)-1].name != m {
			labels = append(labels, label{w, m})
		}
	}
	if len(labels) > 1 && labels[1].col-labels[0].col < 4 {
		labels = labels[1:]
	}
	head := []rune(strings.Repeat(" ", weeks+3))
	for _, l := range labels {
		copy(head[l.col:], []rune(l.name))
	}
	out := []string{"     " + string(head)}
	names := []string{"", "Mon", "", "Wed", "", "Fri", ""}
	for i, r := range rows {
		out = append(out, fmt.Sprintf("%-4s %s", names[i], strings.Join(r, "")))
	}
	return out
}

func monthName(period string) string {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return period
	}
	return t.Format("January 2006")
}

func repoSum(list []server.RepoCount) int {
	n := 0
	for _, r := range list {
		n += r.N
	}
	return n
}

// monthSummary is one month in words: "339 commits in 4 repositories, 61
// branches opened, 19 reviews, created ramos/pando, created the organization plannotator".
func monthSummary(m server.Period) string {
	var parts []string
	if len(m.Commit) > 0 {
		parts = append(parts, counted(repoSum(m.Commit), "commit", "commits")+" in "+counted(len(m.Commit), "repository", "repositories"))
	}
	if len(m.Branch) > 0 {
		parts = append(parts, counted(repoSum(m.Branch), "branch opened", "branches opened"))
	}
	if len(m.Review) > 0 {
		parts = append(parts, counted(repoSum(m.Review), "review", "reviews"))
	}
	for _, c := range m.Created {
		parts = append(parts, "created "+c.FullName)
	}
	for _, o := range m.Joined {
		if o.Created {
			parts = append(parts, "created the organization "+o.Org)
		} else {
			parts = append(parts, "joined "+o.Org)
		}
	}
	return strings.Join(parts, ", ")
}
