// The shell vocabulary every planner shares.
//
// Each planner answers "is this command safe to touch?" with the same
// predicate, and each one rebuilt an argument path from tokens with the same
// two helpers. Those definitions were copied into 22 modules, and one copy had
// already drifted: the backtick was spelled `\x60`, which reads as identical in
// review but is a different regex. A shared leaf module is the fix that stays
// fixed - `ansi.ts` is the precedent.

/**
 * Anything that turns one command into a shell program: pipes, statement
 * separators, redirects, command substitution, backticks, newlines, comments.
 * A bare `$VAR` is allowed - that is plain expansion of the user's own intent,
 * and the planner copies the token verbatim.
 */
export const UNSAFE = /[|;&<>]|\$\(|\$\{|`|\r|\n|#/

/**
 * The last path segment, for display. `slice` after `lastIndexOf` rather than
 * `split('/')` so a quoted path keeps its shape.
 */
export function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1)
}

/**
 * Quote a token only when quoting is needed, so a rewritten command stays close
 * to what the user typed: `git status` rather than `git 'status'`. A backslash
 * is deliberately not in the safe set - unquoted, it escapes the following
 * character and changes the argument.
 */
export function sq(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token
  return "'" + token.replace(/'/g, `'\\''`) + "'"
}
