package meta

// Wire messages (docs/contracts/meta-sync.md). []byte fields are base64 in JSON.

type helloMsg struct {
	Type    string `json:"type"` // hello
	Since   int64  `json:"since"`
	Author  string `json:"author"`
	Machine string `json:"machine"`
	Agent   string `json:"agent,omitempty"`
	Client  string `json:"client"`
}

type saveMsg struct {
	Type  string `json:"type"` // save
	ID    string `json:"id"`
	Path  string `json:"path"`
	Base  int64  `json:"base_version"`
	SHA   string `json:"sha"`
	Bytes []byte `json:"bytes"`
}

type deleteMsg struct {
	Type string `json:"type"` // delete
	ID   string `json:"id"`
	Path string `json:"path"`
	Base int64  `json:"base_version"`
}

type renameMsg struct {
	Type   string `json:"type"` // rename
	ID     string `json:"id"`
	From   string `json:"from"`
	Base   int64  `json:"base_version"`
	Path   string `json:"path"`
	ToBase int64  `json:"to_base_version"`
	SHA    string `json:"sha"`
}

// Current is a path's state on the server, carried by a stale answer.
type Current struct {
	Version int64  `json:"version"`
	SHA     string `json:"sha"`
	Deleted bool   `json:"deleted"`
	Author  string `json:"author"`
	Machine string `json:"machine"`
	At      int64  `json:"at"`
	Bytes   []byte `json:"bytes"`
}

// serverMsg is any message from the object; Type says which fields are set.
type serverMsg struct {
	Type string `json:"type"`

	// welcome, caught_up
	Head int64 `json:"head"`
	More bool  `json:"more"`

	// accepted, stale, refused, change
	ID          string   `json:"id"`
	Op          string   `json:"op"`
	Path        string   `json:"path"`
	From        string   `json:"from"`
	FromVersion int64    `json:"from_version"`
	Version     int64    `json:"version"`
	SHA         string   `json:"sha"`
	Size        int64    `json:"size"`
	Bytes       []byte   `json:"bytes"`
	Deleted     bool     `json:"deleted"`
	Author      string   `json:"author"`
	Machine     string   `json:"machine"`
	Agent       string   `json:"agent"`
	At          int64    `json:"at"`
	Source      string   `json:"source"`
	Status      int      `json:"status"`
	Reason      string   `json:"reason"`
	Message     string   `json:"message"`
	Current     *Current `json:"current"`
}
