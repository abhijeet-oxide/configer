package api

// Choosing where change-request workflow state lives.
//
// There are two stores and neither is right everywhere. The JSON file needs
// nothing installed and is exactly the correct amount of machinery for one
// person managing a repository on their own laptop. The database is what a
// deployment with real editors needs: a write touches one row instead of
// rewriting and fsyncing the whole file, a read-modify-write is a transaction
// rather than a process-local mutex, and two Configer processes behind a load
// balancer see the same drafts - which a file on one of their disks can never
// give them.
//
// The default follows the platform database, because that is already how this
// deployment declared its size. Postgres (DATABASE_URL) means somebody set up
// shared infrastructure for several people; embedded SQLite means the default
// single-machine install, where the file store is no worse and the platform
// pool is deliberately held to ONE connection - routing every editor's
// keystroke through it would put back the very queue this work took apart.
//
// CONFIGER_CR_STORE overrides in either direction for a deployment that knows
// better: "sql" for a busy single-machine install, "file" to stay on disk.

import (
	"log/slog"
	"os"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/crstore"
	"github.com/abhijeet-oxide/configer/backend/internal/store"
	"github.com/abhijeet-oxide/configer/backend/internal/workspace"
)

// crStore builds the change-request store for one application. statePath is
// where its JSON file lives (or would live).
//
// It never fails the application over the store: if the database cannot be
// used, the file store still works, and an application people can edit with
// slightly worse write behaviour beats an application that will not open.
func (h *Hub) crStore(id, statePath string) (crstore.Store, error) {
	fileStore, err := crstore.New(statePath)
	if err != nil {
		return nil, err
	}
	if !h.useSQLCRStore() {
		return fileStore, nil
	}
	sqlStore, err := crstore.NewSQL(h.platform.DB(), h.platform.Dialect(), id)
	if err != nil {
		slog.Warn("could not prepare the change-request database; keeping change requests in a file",
			slog.String("id", id), slog.Any("error", err))
		return fileStore, nil
	}
	// An upgrade must not lose work in flight. Import is a no-op once the
	// database holds anything for this application, so this runs once.
	if err := sqlStore.Import(fileStore); err != nil {
		slog.Warn("could not move existing change requests into the database; keeping them in the file",
			slog.String("id", id), slog.Any("error", err))
		return fileStore, nil
	}
	slog.Info("change requests stored in the platform database",
		slog.String("id", id), slog.String("dialect", h.platform.Dialect()))
	return sqlStore, nil
}

// useSQLCRStore reports whether this deployment keeps change requests in the
// platform database.
func (h *Hub) useSQLCRStore() bool {
	if h.platform == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("CONFIGER_CR_STORE"))) {
	case "sql", "db", "database":
		return true
	case "file", "json":
		return false
	}
	return h.platform.Dialect() == "postgres"
}

// openRegistry builds the connected-repository list.
//
// It always lives in the platform database, unlike the change-request store,
// which keeps a file implementation for small deployments. The reasoning that
// makes the file right there does not apply here: the registry is a handful of
// rows read when an application opens and written when one is connected, so the
// database costs nothing, and it is precisely the state that has to be shared
// for a second replica to know which applications exist or for a restarted pod
// to find them on an empty disk.
//
// An existing workspace.json is read once and imported, so upgrading does not
// disconnect everything somebody already connected. The file is left in place
// afterwards rather than deleted: if an operator needs to roll back, it is
// still the truth for the version they are rolling back to.
//
// Note that access tokens for privately connected repositories move with it,
// from a 0600 file into the database. That is the same protection the platform
// already gives session tokens, and a deployment sharing a registry between
// replicas has to share those too, or half of them cannot fetch.
func openRegistry(dataDir string, platform *store.Store) (workspace.Registry, error) {
	fileReg, err := workspace.Load(dataDir)
	if err != nil {
		return nil, err
	}
	if platform == nil {
		return fileReg, nil
	}
	sqlReg, err := workspace.NewSQL(platform.DB(), platform.Dialect())
	if err != nil {
		slog.Warn("could not prepare the workspace database; keeping the repository list in a file",
			slog.Any("error", err))
		return fileReg, nil
	}
	if err := sqlReg.Import(fileReg); err != nil {
		slog.Warn("could not move the existing repository list into the database; keeping the file",
			slog.Any("error", err))
		return fileReg, nil
	}
	return sqlReg, nil
}
