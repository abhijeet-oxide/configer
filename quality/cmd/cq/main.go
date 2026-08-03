// Command cq is the Continuous Quality Platform's entry point: one static
// binary that discovers analyzers, decides which of them the change actually
// needs, runs them in parallel with a content-addressed cache, and writes one
// normalized report for people, pipelines and AI agents alike.
//
//	cq run --tier pr --base origin/main
//
// See docs/cqp/ for the architecture and the decision records behind it.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/abhijeet-oxide/configer/quality/internal/cli"
)

func main() {
	// A quality run starts child processes, some of them long. Cancelling on a
	// signal rather than dying outright is what lets those children be killed
	// too, instead of being orphaned on a CI runner.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	os.Exit(cli.Main(ctx, os.Args[1:], os.Stdout, os.Stderr))
}
