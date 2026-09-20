/**
 * Calling-agent identity and the B11 single-flight table, as one module.
 *
 * Extracted verbatim from `lib/index.js` (step 5, first cut) so both halves of
 * the guard — how an agent is NAMED, and how a claim is TAKEN and RELEASED —
 * can be exercised on their own, without a Host, a tool registration, or any
 * request plumbing. The pre-extraction behaviour is preserved exactly: this
 * module decides nothing new, it only makes an existing state machine directly
 * reachable from a test.
 *
 * The failure this structure guards against is subtle enough to be worth the
 * separate file: a table that is claimed but never released leaves an agent
 * permanently busy, and a table keyed by the wrong name lets one agent read
 * another's image. Both are properties of this table alone.
 */

/**
 * Every identity key that names the agent behind one tool call.
 *
 * The session id is the host's stable name for one agent's conversation, so two
 * calls from the same agent always agree on it while a parent and its subagent
 * never do. The agent id is a second, independent handle. Object identity is
 * always appended as the last resort, so even a host exposing neither id still
 * gets per-agent (never global) serialization.
 *
 * A call is refused when ANY of its keys is already claimed: the keys are
 * redundant names for ONE agent, so matching on any of them is the safe
 * direction. Keys of different agents never intersect, which is what keeps two
 * agents from blocking each other.
 */
export function identityKeysOf(agent) {
	const keys = [];
	const session = Reflect.get(agent, 'session');
	const sessionId = session == null ? undefined : Reflect.get(session, 'id');
	if (typeof sessionId === 'string' && sessionId !== '') keys.push('session:' + sessionId);
	const agentId = Reflect.get(agent, 'id');
	if (typeof agentId === 'string' && agentId !== '') keys.push('agent:' + agentId);
	keys.push(agent);
	return keys;
}

/**
 * One in-flight table: identity key -> true, where the keys are the redundant
 * names {@link identityKeysOf} returns for the calling agent.
 *
 * Deliberately a SECOND, independent structure rather than a reuse of the view
 * token table:
 *
 *   * the view table is keyed by an opaque per-IMAGE capability token and exists
 *     to authorize byte reads; it lives from just before `ask()` until settle.
 *   * this table is keyed by AGENT identity and exists to serialize calls; it
 *     must be consulted and claimed BEFORE the first image is read, i.e. before
 *     any view token exists at all.
 *
 * Folding them together would mean either minting a token before the admission
 * check — the very side effect B11 forbids — or keying authorization by agent,
 * which would let one agent read another's image. Different keys, different
 * lifetimes, different failure semantics: they stay separate.
 *
 * The returned table is per-`apply()` instance state, and its `clear()` is what
 * plugin disposal calls, so a reload cannot leave an agent permanently busy.
 */
export function createInFlightGuard() {
	const inFlight = new Map();

	/** Claim this agent, or null when a call of the same agent is already live. */
	const claim = (agent) => {
		const keys = identityKeysOf(agent);
		for (const key of keys) {
			if (inFlight.has(key)) return null;
		}
		for (const key of keys) inFlight.set(key, true);
		return keys;
	};

	const release = (keys) => {
		for (const key of keys) inFlight.delete(key);
	};

	const clear = () => {
		inFlight.clear();
	};

	return { claim, release, clear };
}
