// The pointer says the click landed.
//
// Some things a click opens cannot be on screen in the same frame - a dialog
// over a branch of seven hundred settings has work to do first. For the moment
// in between, the ONLY honest feedback is the pointer: without it the click
// reads as ignored, and the second click somebody gives it lands on whatever
// has appeared by then.
//
// It is a class on <body> rather than state passed down a tree, because the
// thing that has to change is the cursor over the WHOLE page - including the
// element the pointer is still sitting on, which by then belongs to whatever is
// opening. And it clears itself on a timer as well as on demand: a cursor stuck
// on "busy" because something threw on the way up is worse than no cursor
// feedback at all.

const CLASS = "cf-busy";
let timer: ReturnType<typeof setTimeout> | undefined;

/** Say the click landed and something is coming. */
export function markBusy(maxMs = 8000): void {
  document.body.classList.add(CLASS);
  clearTimeout(timer);
  timer = setTimeout(clearBusy, maxMs);
}

/** Say it has arrived. Safe to call when nothing was marked. */
export function clearBusy(): void {
  clearTimeout(timer);
  timer = undefined;
  document.body.classList.remove(CLASS);
}
