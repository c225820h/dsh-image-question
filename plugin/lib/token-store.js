/**
 * The view-token table: one opaque capability per attached image, as one module.
 *
 * Extracted verbatim from `lib/index.js` (step 5, first cut) so the token
 * LIFETIME rule — the part that has already been wrong once — can be exercised
 * without a Host, an attachment service, or a route. No behaviour changed in the
 * move: `issue`, `lookup`, and `revoke` are the pre-extraction statements.
 *
 * `lookup` collapses "unknown" and "expired" into one answer on purpose. The
 * route must not tell a caller which case it hit, so the distinction is not
 * allowed to escape this module in the first place.
 */

import { randomUUID } from 'node:crypto';

/**
 * Backstop for a token whose ask never settled cleanly (process kill, transport
 * loss). Normal revocation happens the moment `ask()` settles.
 *
 * It is a FLOOR, not the whole lifetime: a caller may pass a `timeout_ms` longer
 * than this (the runtime re-check used one hour), and the card fetches an image
 * every time it MOUNTS — so a user who pages away and back after the backstop
 * would otherwise find that question's image gone for good, with no way back.
 * `issue` therefore uses the later of this backstop and the request's own
 * deadline.
 */
export const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
/**
 * Added to a request's own deadline before it is compared with the backstop. The
 * card still has to mount and fetch after the question settles, and this keeps
 * the default path byte-identical: max(15 min, 10 min + 1 min) is still 15 min.
 */
export const VIEW_TOKEN_TTL_GRACE_MS = 60 * 1000;

/**
 * Build one token table. Per-`apply()` instance state: the map is created here,
 * `clear()` is what plugin disposal calls, and nothing is shared between two
 * mounted plugin instances.
 *
 * `Date.now()` is read at call time, never captured, so a caller that shifts the
 * clock sees the shift — the same property the route handler relied on before.
 */
export function createViewTokenStore() {
	// token -> { ref, sessionId, expiresAt }. Only an authorization mapping over
	// the existing attachment store; nothing here stores image bytes.
	const views = new Map();

	/**
	 * Mint one opaque capability token for one image, alive for the LATER of the
	 * backstop TTL and the deadline of the request it belongs to: a long
	 * `timeout_ms` must not leave the card holding an image it can no longer fetch.
	 * Revocation is unchanged — the token dies the moment `ask()` settles.
	 */
	const issue = (ref, sessionId, timeoutMs) => {
		const token = randomUUID();
		views.set(token, {
			ref,
			sessionId,
			expiresAt: Date.now() + Math.max(VIEW_TOKEN_TTL_MS, timeoutMs + VIEW_TOKEN_TTL_GRACE_MS),
		});
		return token;
	};

	/**
	 * The reference behind one live token, or null when the token is unknown OR
	 * expired. An expired entry is dropped on the way out, which is this table's
	 * only cleanup: there is no sweeper, so an entry whose token is never looked
	 * up again survives until `clear()`.
	 */
	const lookup = (token) => {
		const entry = views.get(token);
		if (entry === undefined) return null;
		if (entry.expiresAt <= Date.now()) {
			views.delete(token);
			return null;
		}
		return entry;
	};

	const revoke = (tokens) => {
		for (const token of tokens) views.delete(token);
	};

	const clear = () => {
		views.clear();
	};

	return { issue, lookup, revoke, clear };
}
