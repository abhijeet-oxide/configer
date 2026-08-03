package runner

import (
	"context"
	"runtime"
	"sort"
	"sync"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// Outcome is what the scheduler reports back for one analyzer.
type Outcome struct {
	Analyzer model.Analyzer
	// Blocked is set when a prerequisite failed, so nothing was attempted.
	Blocked bool
	Reason  string
	Result  Result
}

// ExecFunc runs one analyzer. It is injected so the scheduler knows nothing
// about caching, normalization or telemetry: it only knows about dependencies,
// parallelism and cancellation.
type ExecFunc func(ctx context.Context, a model.Analyzer) Outcome

// Schedule runs the analyzers respecting `needs`, up to `parallel` at a time.
//
// The ordering rule is worth stating because it is the whole point: an analyzer
// becomes runnable the instant its prerequisites are done, not when its "layer"
// is done. A wave-based scheduler would make a two-minute Playwright run wait
// for a four-second linter in the same wave, which on a real pull request is
// most of the wall clock.
func Schedule(ctx context.Context, analyzers []model.Analyzer, parallel int, exec ExecFunc) []Outcome {
	if parallel <= 0 {
		parallel = runtime.NumCPU()
	}
	if parallel > len(analyzers) && len(analyzers) > 0 {
		parallel = len(analyzers)
	}

	inPlan := map[string]bool{}
	for _, a := range analyzers {
		inPlan[a.ID] = true
	}

	// Pending dependency counts, and the reverse edges to decrement on finish.
	remaining := map[string]int{}
	dependents := map[string][]string{}
	byID := map[string]model.Analyzer{}
	for _, a := range analyzers {
		byID[a.ID] = a
		n := 0
		for _, need := range a.Needs {
			// A prerequisite outside the plan is not a dependency: incremental
			// selection already decided it does not need to run.
			if inPlan[need] {
				n++
				dependents[need] = append(dependents[need], a.ID)
			}
		}
		remaining[a.ID] = n
	}

	ready := make([]string, 0, len(analyzers))
	for id, n := range remaining {
		if n == 0 {
			ready = append(ready, id)
		}
	}
	sortByCost(ready, byID)

	var (
		mu       sync.Mutex
		cond     = sync.NewCond(&mu)
		outcomes = make([]Outcome, 0, len(analyzers))
		failed   = map[string]string{}
		active   int
		done     int
		total    = len(analyzers)
	)

	finish := func(o Outcome) {
		mu.Lock()
		defer mu.Unlock()
		outcomes = append(outcomes, o)
		done++
		active--
		id := o.Analyzer.ID
		if o.Result.Err != nil && !o.Result.Skipped {
			failed[id] = o.Result.Err.Error()
		}
		for _, dep := range dependents[id] {
			remaining[dep]--
			if remaining[dep] == 0 {
				ready = append(ready, dep)
				sortByCost(ready, byID)
			}
		}
		cond.Broadcast()
	}

	var wg sync.WaitGroup
	mu.Lock()
	for done+active < total {
		if ctx.Err() != nil {
			break
		}
		if len(ready) == 0 || active >= parallel {
			cond.Wait()
			continue
		}
		id := ready[0]
		ready = ready[1:]
		a := byID[id]

		// A prerequisite that failed makes this analyzer's answer meaningless.
		// Saying so is better than running it and reporting whatever nonsense
		// it produces against a half-built tree.
		if why, dead := blockedBy(a, failed, inPlan); dead {
			active++
			mu.Unlock()
			finish(Outcome{Analyzer: a, Blocked: true, Reason: why})
			mu.Lock()
			continue
		}

		active++
		wg.Add(1)
		go func(a model.Analyzer) {
			defer wg.Done()
			finish(exec(ctx, a))
		}(a)
	}
	mu.Unlock()
	wg.Wait()

	sort.SliceStable(outcomes, func(i, j int) bool {
		return outcomes[i].Analyzer.ID < outcomes[j].Analyzer.ID
	})
	return outcomes
}

func blockedBy(a model.Analyzer, failed map[string]string, inPlan map[string]bool) (string, bool) {
	for _, need := range a.Needs {
		if !inPlan[need] {
			continue
		}
		if _, bad := failed[need]; bad {
			return need + " did not succeed, so this check could not be trusted", true
		}
	}
	return "", false
}

func sortByCost(ids []string, byID map[string]model.Analyzer) {
	sort.SliceStable(ids, func(i, j int) bool {
		a, b := byID[ids[i]], byID[ids[j]]
		if a.Cost.Weight() != b.Cost.Weight() {
			return a.Cost.Weight() > b.Cost.Weight()
		}
		return a.ID < b.ID
	})
}
