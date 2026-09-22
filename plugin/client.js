/**
 * BROWSER half of dsh-image-question.
 *
 * Hand-written `window.__ModuleLoader__.load({ id, factory })` bundle — this
 * project has no build step, so this file IS the loadable artifact.
 *
 * M3 scope: the annotation feature set and the UI pass. Two tools share the
 * left button (`activeTool` decides), every question owns its own draft
 * (annotations, verdict, note, colour, active tool, and view), the footer is
 * laid out as the four groups in `UI图.png`, and the image area carries its own
 * zoom toolbar plus the annotation-colour control.
 *
 * F1 (fix): image state is token-tagged. The blob URL and the fetch error are
 * stored WITH the view token they belong to, and rendering only accepts them
 * when that token is the current question's. Paging therefore cannot paint the
 * previous question's bitmap under the new question's caption — the stale URL
 * is rejected at render time, not merely cleared later by an effect. An `<img>`
 * key alone was explicitly ruled out as a fix; this is the state-side repair.
 *
 * Coordinate contract: the `<img>` CSS box is the source size and the SVG
 * `viewBox` is `0 0 sourceW sourceH`, so the `world` layer's own coordinate
 * system IS the source-image pixel space. Device pixel ratio never enters any
 * annotation formula — pointer coordinates, `getBoundingClientRect()`, and CSS
 * transforms are all CSS pixels.
 */

/**
 * Step 5, first cut: the pure geometry, registered as its own module.
 *
 * One bundle may register more than one id: `ClientModuleSystem.register`
 * accepts any id unconditionally, and a factory may `require` any
 * registered-but-unmaterialized module. So this needs no build step, no second
 * package and no `dsh.client.external` declaration — both ids arrive from this
 * one script, and load order needs no external sequencing.
 *
 * The two guards around the registration exist because this bundle is NOT
 * invalidated like a normal one: `dsh-client-hmr` calls `invalidate(<id>)` for
 * the MAIN id only, so after a hot update the previous logic registration is
 * still live. An unguarded second `load` would THROW inside the script —
 * aborting it before the main id is ever registered, which is a dead card, not a
 * duplicate. A stale registration also still satisfies `require`, which is why
 * the handshake is a `revision` string: the main factory prefers its own
 * factory whenever the registered revision is not this bundle's.
 */
const LOGIC_MODULE_ID = 'dsh-image-question/logic';
/** Bumped when the logic module's exports change shape or behaviour. */
const LOGIC_REVISION = 'step5-geometry-1';

/**
 * The pure geometry. No DOM, no React, no platform module — every function here
 * is synchronous and total, which is what makes it directly testable.
 */
function createLogicModule() {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

	/** Handshake the main factory reads after a hot update. */
	exports.revision = LOGIC_REVISION;

	function clamp(value, low, high) {
		if (value < low) return low;
		if (value > high) return high;
		return value;
	}

	/** Normalize a drag into a positive-extent rect, in source pixels. */
	function rectOf(drag) {
		return {
			x: Math.min(drag.x0, drag.x1),
			y: Math.min(drag.y0, drag.y1),
			width: Math.abs(drag.x1 - drag.x0),
			height: Math.abs(drag.y1 - drag.y0),
		};
	}

	/** Squared distance from `p` to the segment `a`-`b`. */
	function segmentDistance2(p, a, b) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		if (dx === 0 && dy === 0) {
			const px = p.x - a.x;
			const py = p.y - a.y;
			return px * px + py * py;
		}
		const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
		const qx = a.x + t * dx - p.x;
		const qy = a.y + t * dy - p.y;
		return qx * qx + qy * qy;
	}

	/**
	 * Ramer-Douglas-Peucker on a source-space polyline. Iterative (an
	 * explicit stack) because a stroke can hold thousands of points and the
	 * obvious recursion is deep enough to matter.
	 */
	function rdpSimplify(points, epsilon) {
		if (points.length < 3) return points.slice();
		const keep = new Array(points.length);
		keep[0] = true;
		keep[points.length - 1] = true;
		const epsilon2 = epsilon * epsilon;
		const stack = [[0, points.length - 1]];
		while (stack.length > 0) {
			const range = stack.pop();
			const first = range[0];
			const last = range[1];
			let worst = -1;
			let index = -1;
			for (let i = first + 1; i < last; i += 1) {
				const d2 = segmentDistance2(points[i], points[first], points[last]);
				if (d2 > worst) {
					worst = d2;
					index = i;
				}
			}
			if (worst > epsilon2 && index > first) {
				keep[index] = true;
				stack.push([first, index]);
				stack.push([index, last]);
			}
		}
		const out = [];
		for (let i = 0; i < points.length; i += 1) {
			if (keep[i] === true) out.push(points[i]);
		}
		return out;
	}

	/** Contain-fit scale of the source image inside the viewport, or 1 before layout. */
	function containFit(viewport, source) {
		return viewport.w > 0 && viewport.h > 0 && source.w > 0 && source.h > 0
			? Math.min(viewport.w / source.w, viewport.h / source.h)
			: 1;
	}

	/**
	 * The world layer's transform for one render. `view` stores a zoom ratio plus
	 * the source point held at the viewport centre, so a window resize keeps that
	 * point under the cursor instead of drifting with tx/ty.
	 */
	function worldTransform(viewport, view, source) {
		const sFit = containFit(viewport, source);
		const scale = sFit * view.zoomRatio;
		return {
			sFit,
			scale,
			tx: viewport.w / 2 - view.centerX * scale,
			ty: viewport.h / 2 - view.centerY * scale,
		};
	}

	/**
	 * Map one client point to source pixels and clamp it to the image. `origin` is
	 * the CONTENT-box corner in client coordinates — the caller measures it,
	 * because that measurement is the one part that needs the DOM. See
	 * `sourcePointOf` for why the origin is not the border box the DOM reports.
	 */
	function toSourcePoint(client, origin, transform, source) {
		return {
			x: clamp((client.x - origin.x - transform.tx) / transform.scale, 0, source.w),
			y: clamp((client.y - origin.y - transform.ty) / transform.scale, 0, source.h),
		};
	}

	exports.clamp = clamp;
	exports.rectOf = rectOf;
	exports.segmentDistance2 = segmentDistance2;
	exports.rdpSimplify = rdpSimplify;
	exports.containFit = containFit;
	exports.worldTransform = worldTransform;
	exports.toSourcePoint = toSourcePoint;

	return module.exports;
}

try {
	window.__ModuleLoader__.load({ id: LOGIC_MODULE_ID, factory: createLogicModule });
} catch {
	// A hot update re-executes this script while the previous registration is
	// still in the platform table, and re-registering throws. Nothing is lost by
	// stopping here: the main factory below keeps its own factory as the
	// authority whenever the registered revision does not match.
}

window.__ModuleLoader__.load({
	id: 'dsh-image-question',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;

		// Step 5: the pure geometry comes from the module this bundle registers
		// under `LOGIC_MODULE_ID`. The platform table is preferred because that is
		// the whole point of the registration — but only when the registered
		// revision is this bundle's: after a hot update the table still holds the
		// PREVIOUS build, and new card code must never run against old geometry.
		let registered = null;
		try {
			registered = require(LOGIC_MODULE_ID);
		} catch {
			registered = null;
		}
		const logic = registered !== null && registered.revision === LOGIC_REVISION
			? registered
			: createLogicModule();
		const clamp = logic.clamp;
		const rectOf = logic.rectOf;
		const rdpSimplify = logic.rdpSimplify;
		const worldTransform = logic.worldTransform;
		const toSourcePoint = logic.toSourcePoint;

		const REQUEST_SCHEMA = 'dsh.image-annotation.request/v1';
		const ANSWER_SCHEMA = 'dsh.image-annotation.answer/v1';
		const COORDINATE_SPACE = 'source-oriented-pixel-edge';
		/** Host route serving one attached image for one opaque view token. */
		const VIEW_ROUTE_PATH = '/api/image-question.view';
		const DEFAULT_COLOR = '#fa0202';
		/**
		 * B1: the eyebrow's fallback text. `UI图.png` shows a single "NG 标注" line;
		 * the request protocol carries no eyebrow field, so this stays a constant
		 * and a request-supplied `header` simply replaces it — never both.
		 */
		const DEFAULT_EYEBROW = 'NG 标注';
		/** Verdict labels the Host vocabulary accepts. */
		const VERDICT_LABEL = { ng: 'NG', ok: 'OK', unsure: '不确定' };
		/** Display order of the verdict choices, matching `UI图.png`. */
		const VERDICT_ORDER = ['ng', 'ok', 'unsure'];
		/** Zoom bounds as a multiple of the contain-fit scale. */
		const ZOOM_MIN = 0.1;
		const ZOOM_MAX = 64;
		/** A drag shorter than this many source pixels is treated as a stray click. */
		const MIN_RECT_SOURCE_PX = 1;

		/** One click of the zoom-in / zoom-out buttons. */
		const ZOOM_BUTTON_FACTOR = 1.25;
		/** On-screen brush width, authored in SOURCE pixels: the renderer divides
		 * it by the live scale, which keeps the drawn stroke at ~2 CSS px. 需求4:
		 * 6 -> 2 so a thin defect is no longer covered. */
		const BRUSH_WIDTH_PX = 2;
		/** A brush point is recorded only past this on-screen distance. */
		const BRUSH_MIN_STEP_PX = 2;
		/**
		 * Screen-pixel travel that marks a press as a DRAG rather than a click.
		 * 需求3: it is BOOKKEEPING only — the point count decides whether a press
		 * was a stroke (>= 2 sampled points) or a lasso vertex (1 point), so a
		 * short stroke that did sample two points is never vetoed by this value.
		 */
		const BRUSH_MOVED_PX = 4;
		/** Hard per-stroke ceiling so `custom` can never balloon. */
		const BRUSH_MAX_POINTS = 4096;
		/** Ramer-Douglas-Peucker tolerance, in on-screen pixels. */
		const RDP_EPSILON_PX = 1.5;
		/** Used only when the request carries no `noteMaxLength`. */
		const FALLBACK_NOTE_MAX = 200;
		/** Used only when the request carries no usable `palette`. */
		const FALLBACK_PALETTE = ['#fa0202', '#ffcc00', '#34c759', '#0a84ff'];
		const FALLBACK_TOOLS = ['rect', 'brush'];
		/**
		 * Accent for the submit button and the armed tool chip, matching 图 UI.
		 * Measured off `UI图.png`: the submit button's fill is #0053fd / #0050ff /
		 * #004dfd / #0049fe / #0053ff / #0051fe at six interior samples (median
		 * #0050fd), so the value is taken from the image rather than from a theme
		 * token — `--dsw-specific-input-major` is the card's own surface, and the
		 * brand aliases resolve to black / white, not to a blue.
		 */
		const ACCENT = '#0050fd';
		/** Handshake marker, so a verifier can tell which milestone is loaded. */
		const MARKER = 'm4';
		const CSS_ELEMENT_ID = 'dsh-image-question-css';

		/**
		 * Plugin-owned surfaces (`UI差异与修改方案.md` v2, A1-A5/C2, 2026-09-18) are
		 * CSS VARIABLES now, declared by `ensureStyle()` and branched on the host's
		 * own resolved-theme marker:
		 *
		 *   --dsh-iq-surface-card / -input / -control  card, note field, colour control + palette
		 *   --dsh-iq-border-control                    their hairline
		 *   --dsh-iq-label-caret                       the swatch caret
		 *   --dsh-iq-zoom-plate / -plate-border        the zoom toolbar and its plate edge
		 *   --dsh-iq-zoom-button                       the buttons' resting fill
		 *   --dsh-iq-notice-surface                    the read-image failure notice
		 *
		 * Values are here twice on purpose. The DARK branch is the frozen accepted
		 * baseline sampled off `UI图.png`; the LIGHT branch is sampled off
		 * `浅色主题-UI图.png`. `UI图.png` draws the whole card as ONE dark family,
		 * which is why the card, the note field and the colour control used to be
		 * hardcoded against the host theme; on a light host that read as a dark card
		 * with light blocks in it. Living in CSS is what lets an ALREADY-MOUNTED
		 * card follow a live theme switch — no React remount, no `matchMedia` probe,
		 * no `MutationObserver`, no new host dependency.
		 */

		/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
		function hostBase() {
			const origin = globalThis.location === undefined ? undefined : globalThis.location.origin;
			return origin !== undefined && origin !== null && origin !== 'null' ? origin : 'http://dsh.internal';
		}

		/**
		 * The viewport's border widths, in CSS pixels.
		 *
		 * The world layer is laid out at the viewport's CONTENT-box origin
		 * (`position: absolute; left: 0; top: 0` resolves against the padding box,
		 * and that padding is 0) and is transformed about `transform-origin: 0 0`,
		 * while `getBoundingClientRect()` reports the BORDER box. Measuring a client
		 * point from the border-box corner therefore maps every source point
		 * `borderWidth / scale` pixels away from where the browser actually draws it
		 * — a constant translation (≈22 source px at fit zoom, ≈0.34 at 64×).
		 * `clientLeft` cannot repair this: it is rounded to an integer, which is
		 * 0.0909 CSS px wrong at a 1.1 device pixel ratio. The computed widths are
		 * exact, so they are read once per render and cached with the transform.
		 */
		function borderWidthsOf(element) {
			if (element === null || element === undefined) return { x: 0, y: 0 };
			if (typeof getComputedStyle !== 'function') return { x: 0, y: 0 };
			const style = getComputedStyle(element);
			const x = parseFloat(style.borderLeftWidth);
			const y = parseFloat(style.borderTopWidth);
			return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
		}

		/** Request-supplied colour palette, falling back to the built-in one. */
		function paletteOf(spec) {
			const own = spec.palette;
			if (!Array.isArray(own)) return FALLBACK_PALETTE.slice();
			const usable = own.filter((entry) => typeof entry === 'string' && entry !== '');
			return usable.length > 0 ? usable : FALLBACK_PALETTE.slice();
		}

		/** Request-supplied note limit, falling back to the built-in one. */
		function noteMaxOf(spec) {
			const own = spec.noteMaxLength;
			return Number.isFinite(own) && own > 0 ? Math.floor(own) : FALLBACK_NOTE_MAX;
		}

		/** Request-supplied tool list; `rect` stays the default when allowed. */
		function toolsOf(spec) {
			const own = spec.allowedTools;
			if (!Array.isArray(own)) return FALLBACK_TOOLS.slice();
			const usable = own.filter((entry) => entry === 'rect' || entry === 'brush');
			return usable.length > 0 ? usable : FALLBACK_TOOLS.slice();
		}

		/**
		 * One question's own draft. Every field the answer needs lives here from
		 * M2 on, keyed by the question's POSITION in the batch.
		 */
		function initialDraftFor(question) {
			const spec = question.imageAnnotation;
			const image = spec.image;
			const tools = toolsOf(spec);
			const palette = paletteOf(spec);
			return {
				annotations: [],
				// This question's OWN undo history: one id per committed step, in the
				// order the steps were taken. It lives on the draft, so paging away and
				// back — or drawing on another question — can never mix two histories.
				undoStack: [],
				verdict: 'unsure',
				note: '',
				color: palette.indexOf(DEFAULT_COLOR) >= 0 ? DEFAULT_COLOR : palette[0],
				activeTool: tools.indexOf('rect') >= 0 ? 'rect' : tools[0],
				// A zoom ratio plus the source-space point held at the viewport centre:
				// survives a resize, and restores verbatim when the user pages back.
				view: {
					zoomRatio: 1,
					centerX: image.sourceWidth / 2,
					centerY: image.sourceHeight / 2,
				},
			};
		}

		/** One annotation, serialized for the wire. `rect` keeps its M1 shape. */
		function annotationOf(entry) {
			if (entry.type === 'brush') {
				return {
					id: entry.id,
					type: 'brush',
					color: entry.color,
					width: entry.width,
					points: entry.points.map((point) => ({ x: point.x, y: point.y })),
				};
			}
			return {
				id: entry.id,
				type: entry.type,
				color: entry.color,
				rect: entry.rect,
			};
		}

		/** Build one question's `custom` payload from its own draft, and only it. */
		function buildAnswerPayload(question, draft) {
			const spec = question.imageAnnotation;
			const image = spec.image;
			const count = draft.annotations.length;
			// The last mark describes what the user settled on; with no mark the
			// payload keeps the standing colour and reports no tool at all.
			const last = count > 0 ? draft.annotations[count - 1] : null;
			return {
				schema: ANSWER_SCHEMA,
				tool: last === null ? null : last.type,
				color: last === null ? draft.color : last.color,
				verdict: draft.verdict,
				note: draft.note,
				image: {
					sourceWidth: image.sourceWidth,
					sourceHeight: image.sourceHeight,
					storedWidth: image.storedWidth,
					storedHeight: image.storedHeight,
				},
				coordinateSpace: spec.coordinateSpace === undefined ? COORDINATE_SPACE : spec.coordinateSpace.kind,
				annotations: draft.annotations.map(annotationOf),
			};
		}

		/**
		 * Strict takeover test. A false positive would steal a card this UI
		 * cannot render, so every clause is a hard requirement:
		 * `every` (not `some`) keeps mixed batches on the official flow, an
		 * `intent`-bearing question belongs to plan-review, and the image payload
		 * must be complete because the viewport divides by `sourceWidth/Height`
		 * and immediately fetches with `viewToken`.
		 */
		function isImageAnnotationPending(pending) {
			if (!pending || typeof pending !== 'object') return false;
			if (pending.kind !== 'question') return false;
			if (typeof pending.answer !== 'function') return false;
			if (typeof pending.cancel !== 'function') return false;
			const questions = pending.questions;
			if (!Array.isArray(questions) || questions.length === 0) return false;
			return questions.every((question) => {
				if (!question || typeof question !== 'object') return false;
				// Never touch an intent-bearing request: plan-review owns those.
				if (question.intent != null) return false;
				const spec = question.imageAnnotation;
				if (!spec || typeof spec !== 'object') return false;
				if (spec.schema !== REQUEST_SCHEMA) return false;
				const image = spec.image;
				if (!image || typeof image !== 'object') return false;
				const attachment = image.attachment;
				if (!attachment || typeof attachment !== 'object') return false;
				if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') return false;
				// The card fetches through this plugin's own view route, so a request
				// without its capability token could only render a broken card.
				if (typeof image.viewToken !== 'string' || image.viewToken === '') return false;
				if (!Number.isFinite(image.sourceWidth) || !Number.isFinite(image.sourceHeight)) return false;
				if (image.sourceWidth <= 0 || image.sourceHeight <= 0) return false;
				return true;
			});
		}

		/**
		 * M5 error-boundary bookkeeping. Module scope on purpose: the takeover
		 * election runs in the selector, which must still see what happened to the
		 * last render after React has already torn the failing card down.
		 *
		 * The count is REQUEST-SCOPED: `renderFailureToken` names the request it
		 * belongs to, so "two failures before abdication" can only ever mean two
		 * failures of the SAME request. Without that key the budget would be spent
		 * module-wide, and one failure of request A would let a single failure of an
		 * unrelated request B reach the threshold and abdicate B.
		 *
		 * `abdicated` means "this exact request has already killed the renderer, so
		 * stop taking it over and let the official card serve it". It is NOT
		 * permanent — a request carrying a DIFFERENT view token clears it — so one
		 * broken request cannot disable the plugin for the rest of the session.
		 */
		const FAILURES_BEFORE_ABDICATION = 2;
		let renderFailureToken = null;
		let renderFailureCount = 0;
		let abdicated = false;
		let abdicatedToken = null;

		/** The view token that identifies a request, or null when it carries none. */
		function firstViewTokenOf(pending) {
			const questions = pending === null || pending === undefined ? undefined : pending.questions;
			if (!Array.isArray(questions) || questions.length === 0) return null;
			const question = questions[0];
			const spec = question === null || question === undefined ? undefined : question.imageAnnotation;
			const image = spec === null || spec === undefined ? undefined : spec.image;
			const token = image === null || image === undefined ? undefined : image.viewToken;
			return typeof token === 'string' && token !== '' ? token : null;
		}

		/**
		 * Point the failure counter at one request. Every caller passes the token it
		 * is about to serve or count, so a token change IS the reset; nothing else
		 * resets it, and a repeated call for the same token keeps the count.
		 */
		function scopeRenderFailureTo(token) {
			if (token === renderFailureToken) return;
			renderFailureToken = token;
			renderFailureCount = 0;
		}

		/**
		 * A short, user-facing summary of a render failure. Deliberately never a
		 * stack trace and never a dumped object: the card is read by a person, and a
		 * render failure can carry host internals.
		 */
		function summarizeFailure(error) {
			const raw = error instanceof Error
				? (error.name === '' ? 'Error' : error.name)
					+ (typeof error.message === 'string' && error.message !== '' ? ': ' + error.message : '')
				: String(error);
			return raw.length > 160 ? raw.slice(0, 160) + '…' : raw;
		}

		/**
		 * Hover and focus states cannot be expressed with inline styles, so the
		 * few rules that need a pseudo-class live in one injected style element —
		 * the same shape the official bundles use for their CSS modules.
		 *
		 * It also carries the plugin's theme variables. They are declared on the
		 * plugin's own scope, so nothing here leaks into the host's stylesheet.
		 */
		function ensureStyle() {
			if (typeof document === 'undefined') return;
			if (document.getElementById(CSS_ELEMENT_ID) !== null) return;
			const style = document.createElement('style');
			style.id = CSS_ELEMENT_ID;
			style.setAttribute('data-plugin-css', 'dsh-image-question');
			style.textContent = [
				// Plugin-scoped theme variables. The bare selector carries the LIGHT
				// branch, sampled point by point off `浅色主题-UI图.png`; the host's own
				// `data-ds-dark-theme` marker on `body` selects the DARK branch, which
				// is the frozen accepted baseline value for value. The marker is the
				// host's RESOLVED theme, so `system` follows it for free.
				'[data-dsh-image-question]{',
				'--dsh-iq-surface-card:rgb(254,254,254);',
				'--dsh-iq-surface-input:rgb(254,254,254);',
				'--dsh-iq-surface-control:rgb(254,254,254);',
				'--dsh-iq-border-control:rgb(227,230,235);',
				'--dsh-iq-zoom-plate:rgba(254,254,254,.98);',
				'--dsh-iq-zoom-plate-border:rgba(0,0,0,.06);',
				'--dsh-iq-zoom-button:rgb(254,254,254);',
				'--dsh-iq-label-caret:rgb(10,106,252);',
				'--dsh-iq-notice-surface:rgba(254,254,254,.98)',
				'}',
				'body[data-ds-dark-theme] [data-dsh-image-question]{',
				'--dsh-iq-surface-card:rgb(20,21,24);',
				'--dsh-iq-surface-input:rgb(25,27,31);',
				'--dsh-iq-surface-control:rgb(19,20,22);',
				'--dsh-iq-border-control:rgb(44,46,49);',
				'--dsh-iq-zoom-plate:rgba(22,23,26,.98);',
				'--dsh-iq-zoom-plate-border:rgba(255,255,255,.06);',
				'--dsh-iq-zoom-button:rgba(255,255,255,.03);',
				'--dsh-iq-label-caret:rgb(120,190,235);',
				'--dsh-iq-notice-surface:rgba(22,23,26,.98)',
				'}',
				'.dsh-iq-icon{transition:background-color .12s,color .12s}',
				'.dsh-iq-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#101828)}',
				'.dsh-iq-icon:disabled{color:var(--dsw-alias-label-dimmed,#98a2b3);cursor:default}',
				// D2: the zoom buttons rest on a scoped fill so their `:hover` can win.
				'.dsh-iq-zoom{background:var(--dsh-iq-zoom-button)}',
				'.dsh-iq-zoom:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
				'.dsh-iq-seg{transition:background-color .12s,border-color .12s,color .12s}',
				'.dsh-iq-seg:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}',
				'.dsh-iq-seg:disabled{cursor:default;opacity:.45}',
				'.dsh-iq-verdict{transition:background-color .12s,border-color .12s}',
				'.dsh-iq-verdict:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}',
				'.dsh-iq-option{transition:background-color .12s}',
				'.dsh-iq-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
				'.dsh-iq-swatch{transition:border-color .12s}',
				'.dsh-iq-swatch:hover{border-color:var(--dsw-alias-border-l4,#101828)}',
				'.dsh-iq-submit{transition:filter .12s}',
				'.dsh-iq-submit:hover:not(:disabled){filter:brightness(1.08)}',
				'.dsh-iq-submit:disabled{opacity:.5;cursor:default}',
				'.dsh-iq-note:focus{outline:none;border-color:var(--dsw-alias-border-l4,#101828)}',
			].join('');
			document.head.appendChild(style);
		}

		/** Shared geometry for every hand-drawn glyph (the icon set lacks these). */
		function glyph(props) {
			return h('svg', {
				width: props.size,
				height: props.size,
				viewBox: '0 0 16 16',
				fill: 'none',
				// C1/P4: only the rect tool's glyph is asked for the current annotation
				// colour; every other icon leaves this at `currentColor` and inherits
				// the light text colour the figure draws the brush/undo icons in.
				stroke: props.color === undefined ? 'currentColor' : props.color,
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false',
				style: { display: 'block' },
			}, props.children);
		}

		/** Magnifier with a plus — zoom in. */
		function IconZoomIn(props) {
			return h(glyph, { size: props.size },
				h('circle', { cx: 7, cy: 7, r: 4.1 }),
				h('path', { d: 'M10.1 10.1 14 14' }),
				h('path', { d: 'M7 5.3v3.4M5.3 7h3.4' }));
		}

		/** Magnifier with a minus — zoom out. */
		function IconZoomOut(props) {
			return h(glyph, { size: props.size },
				h('circle', { cx: 7, cy: 7, r: 4.1 }),
				h('path', { d: 'M10.1 10.1 14 14' }),
				h('path', { d: 'M5.3 7h3.4' }));
		}

		/** Four corner brackets — fit the image back into the viewport. */
		function IconFit(props) {
			return h(glyph, { size: props.size },
				h('path', { d: 'M2.5 6V3.5a1 1 0 0 1 1-1H6' }),
				h('path', { d: 'M10 2.5h2.5a1 1 0 0 1 1 1V6' }),
				h('path', { d: 'M13.5 10v2.5a1 1 0 0 1-1 1H10' }),
				h('path', { d: 'M6 13.5H3.5a1 1 0 0 1-1-1V10' }));
		}

		/** Dashed selection rectangle — the rect tool. */
		function IconRectTool(props) {
			// C1: this glyph takes the current annotation colour when one is passed.
			return h(glyph, { size: props.size, color: props.color },
				h('rect', {
					x: 2.6, y: 3.6, width: 10.8, height: 8.8, rx: 1.2,
					strokeDasharray: '2.6 2',
				}));
		}

		/** Slanted nib with a stroke — the brush tool. */
		function IconBrushTool(props) {
			return h(glyph, { size: props.size },
				h('path', { d: 'M11.2 2.6 13.4 4.8 6.6 11.6l-3 .8.8-3z' }),
				h('path', { d: 'M9.8 4 12 6.2' }));
		}

		/** Circular arrow — 撤销 steps this question's marks back one at a time. */
		function IconRedraw(props) {
			return h(glyph, { size: props.size },
				h('path', { d: 'M3 7.6a5 5 0 1 1 1.7 3.7' }),
				h('path', { d: 'M2.6 3.8v3.9h3.9' }));
		}

		function IconChevronLeft(props) {
			return h(glyph, { size: props.size }, h('path', { d: 'M9.8 3.6 5.6 8l4.2 4.4' }));
		}

		function IconChevronRight(props) {
			return h(glyph, { size: props.size }, h('path', { d: 'M6.2 3.6 10.4 8l-4.2 4.4' }));
		}

		function IconChevronDown(props) {
			return h(glyph, { size: props.size }, h('path', { d: 'M3.6 6.2 8 10.4l4.4-4.2' }));
		}

		/**
		 * B4: the collapsed card offers "expand", so its affordance points the other
		 * way. The expanded card shows the figure's own down-chevron (「收起」).
		 */
		function IconChevronUp(props) {
			return h(glyph, { size: props.size }, h('path', { d: 'M3.6 9.8 8 5.6l4.4 4.2' }));
		}

		function IconClose(props) {
			return h(glyph, { size: props.size }, h('path', { d: 'M4 4 12 12M12 4 4 12' }));
		}

		const styles = {
			frame: {
				padding: '6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px',
				display: 'flex',
				justifyContent: 'center',
			},
			card: {
				width: '100%',
				maxWidth: 'var(--dsh-chat-content-width, 860px)',
				// A1: the card takes the plugin's own surface token, so one card renders
				// the figure's dark family on a dark host and the light sample on a light
				// one — never a mix of the two.
				background: 'var(--dsh-iq-surface-card)',
				borderRadius: '16px',
				boxShadow: 'var(--dsw-elevation-panel, 0 1px 2px rgba(16,24,40,0.06))',
				color: 'var(--dsw-alias-label-primary, #101828)',
				padding: '0 0 12px',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
				boxSizing: 'border-box',
				font: '13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
			},
			header: {
				flexShrink: 0,
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'flex-start',
				gap: '16px',
				// `UI图.png`: the eyebrow's ink starts 25.5 image px below the card's
				// top edge (525.5px scale), i.e. ~17 CSS px for the line box plus its
				// half-leading; the title ink at 562 cross-checks the same padding.
				padding: '14px 12px 0 20px',
			},
			headingBlock: { minWidth: 0 },
			eyebrow: {
				color: 'var(--dsw-alias-label-tertiary, #475467)',
				marginBottom: '5px',
				fontSize: '11px',
				lineHeight: '16px',
				display: 'flex',
				alignItems: 'center',
				gap: '8px',
			},
			title: { margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: '22px' },
			headerActions: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px' },
			iconButton: {
				width: '24px',
				height: '24px',
				border: 'none',
				borderRadius: '999px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-tertiary, #475467)',
				cursor: 'pointer',
				padding: 0,
				display: 'grid',
				placeItems: 'center',
				flexShrink: 0,
			},
			imageRow: { position: 'relative', margin: '12px 16px 0' },
			viewport: {
				position: 'relative',
				overflow: 'hidden',
				// 需求2 + T4 (林爷裁定 2026-09-18): the picture area is a SQUARE whose
				// side is min(card width, half the viewport height) — never wider than
				// the card, never taller than half the page.
				//
				// The bound rides on `width`, the SIDE, and never on `height` or
				// `maxHeight`: a height cap fights `aspectRatio` and turns the square
				// into a rectangle. The runtime verifier measured exactly that in T1 —
				// `maxHeight: 'min(70vh, 720px)'` deformed the box to 544.03 x 395.17
				// at a 750px-high window (ratio 1.377), and its 720px branch could
				// never fire under the card's 680px max-width. Sizing the side keeps
				// the ratio authoritative: under the breakpoint the box shrinks, it
				// never deforms. `margin: 0 auto` centres it once it is narrower than
				// the row.
				//
				// This also supersedes the old measurement baseline — `UI图.png` drew
				// the box 248.5 image px tall (a flat strip at the figure's 1.5 scale).
				// Colours, spacing and hierarchy still follow the figure.
				width: 'min(100%, 50vh)',
				aspectRatio: '1 / 1',
				height: 'auto',
				margin: '0 auto',
				boxSizing: 'border-box',
				borderRadius: '10px',
				border: '1px solid var(--dsw-alias-border-l2, #eaecf0)',
				background: 'var(--dsw-alias-bg-base, #f2f4f7)',
				touchAction: 'none',
				userSelect: 'none',
			},
			world: { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0' },
			image: { display: 'block', imageRendering: 'auto', userSelect: 'none', pointerEvents: 'none' },
			overlay: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' },
			/**
			 * A4/B2: the figure has no readout strip, so the three readings (source
			 * size, zoom, mark count) are gone. What stays is the image-FAILURE
			 * notice: the card must not silently show an empty viewport when the view
			 * token expired or the fetch failed (the M1/M5-accepted degraded state),
			 * and the figure has no opinion about a failure state it never draws. Its
			 * surface follows the same plugin-owned family as the zoom plate, which is
			 * why it shares that plate's alpha and only differs by branch.
			 */
			imageErrorNotice: {
				position: 'absolute',
				left: '8px',
				bottom: '6px',
				display: 'flex',
				gap: '10px',
				pointerEvents: 'none',
				font: '10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
				color: 'var(--dsw-alias-state-error-primary, #ff3b30)',
				background: 'var(--dsh-iq-notice-surface)',
				borderRadius: '4px',
				padding: '1px 6px',
			},
			zoomToolbar: {
				position: 'absolute',
				// `UI图.png` (scale 1.5): the zoom buttons centre at y≈641 image px and
				// the colour dot at y=642.5 image px — 21.7 / 22.7 CSS px below the image
				// row's top edge, i.e. both controls live on ONE row, zoom group left of
				// the colour control. So the group no longer hugs the right edge: its
				// right edge lands at x≈1164 image px, which is 90 CSS px inside the
				// viewport's right edge — far enough left that the two boxes no longer
				// overlap. The figure puts the third button's right edge at x=1160 and
				// the swatch's left edge at x≈1208 (~25 CSS px of air at that width).
				top: '6px',
				right: '90px',
				display: 'flex',
				alignItems: 'center',
				// Buttons are 36 image px wide with a 12 image px gap between them:
				// 24 CSS px each, 8 CSS px apart.
				gap: '8px',
				padding: '3px',
				borderRadius: '10px',
				// V4: the figure's panel is a DARK plate, not the opaque light grey this
				// used before (rgb(97,102,107), luminance 101). Measured inside the panel at
				// the figure's 1.5 scale: rgb(20,21,23) at the top edge rising to
				// rgb(31,32,34) near the bottom (luminance 21 → 32, the same order as the
				// card's own surface). The plate COVERS the image rather than tinting it
				// with white: just outside the panel's left edge the image is bright
				// (rgb(92,92,91) at x=1008) while inside it reads rgb(23,24,26) at x=1018, a
				// jump that happens within 4 image px. Alpha 98% is the calibration the
				// runtime re-check asked for. Compositing is per channel, result =
				// a*plate + (1-a)*underlying, with plate (22,23,26) and the bright
				// underlying (92,92,91) measured outside the panel: 88% lands on
				// (30.4,31.3,33.8) = luminance 31.0 — the re-check measured 32.0 where the
				// figure reads 24.3 — while 98% lands on (23.4,24.4,27.3) = luminance 24.4,
				// matching the figure's 6-point mean of 24.3 inside its 20.0-29.0 band. Over
				// the card's dark surface (21,21,23) 98% lands on luminance 23.0, inside the
				// figure's dark-side band of 20-23. That plate, and the plate's own
				// hairline, are the DARK branch of the two tokens below; the light
				// branch is the `浅色主题-UI图.png` sample.
				background: 'var(--dsh-iq-zoom-plate)',
				border: '1px solid var(--dsh-iq-zoom-plate-border)',
			},
			zoomButton: {
				width: '24px',
				height: '24px',
				border: 'none',
				// `UI图.png` outlines a rounded SQUARE, not a circle: the box is 36
				// image px wide, its top edge sits at y=621, and the outline widens
				// 28 → 30 → 32 → 35 image px over y=623 → 626, which fits a corner
				// radius of ≈7 image px = 5 CSS px.
				borderRadius: '5px',
				// The buttons carry their own faint fill, one step ABOVE the panel
				// plate: their surface measures rgb(27,29,32) ≈ luminance 29.5 where
				// the plate between them measures rgb(20,21,23) ≈ 22. Against the
				// plate that is a 3% white wash. D2: that fill is carried by the
				// injected `.dsh-iq-zoom` rule instead of by this object — an INLINE
				// background outranks every class-based `:hover` rule, so keeping it
				// here silently swallowed the hover feedback `.dsh-iq-icon:hover`
				// already provides (the browser reported `:hover` true with a
				// byte-identical colour). The resting value itself is unchanged.
				color: 'var(--dsw-alias-label-secondary, #475467)',
				cursor: 'pointer',
				padding: 0,
				display: 'grid',
				placeItems: 'center',
			},
			colorControl: {
				position: 'absolute',
				// V2: same row as the zoom group, to its right. The image puts this
				// control's swatch row at the zoom buttons' height (dot centre
				// y=642.5 image px vs button centre y≈641 image px, a 1 CSS px gap).
				//
				// P8: the "标注颜色" text label is gone — the figure shows the swatch
				// alone — so the box contains exactly one row now and starts 18 CSS px
				// lower: the label's own line box (14) plus the column gap (4). That
				// compensation is what keeps the swatch row at the SAME screen position
				// the V2 measurement above pins down; dropping the label without it
				// would have lifted the swatch 18 px out of the zoom buttons' row.
				top: '4px',
				right: '8px',
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'stretch',
				gap: '4px',
				padding: '5px 7px 6px',
				borderRadius: '10px',
				// A3: the control takes the plugin's control surface, with the figure's
				// own hairline — both from the branch the host theme selects.
				background: 'var(--dsh-iq-surface-control)',
				border: '1px solid var(--dsh-iq-border-control)',
			},
			swatch: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '8px',
				width: '52px',
				height: '26px',
				padding: '0 5px',
				borderRadius: '7px',
				border: '1px solid var(--dsw-alias-border-l2, #eaecf0)',
				background: 'transparent',
				cursor: 'pointer',
			},
			swatchDot: {
				width: '16px',
				height: '16px',
				borderRadius: '999px',
				display: 'block',
				flexShrink: 0,
			},
			swatchCaret: { color: 'var(--dsh-iq-label-caret)', display: 'block' },
			palettePanel: {
				position: 'absolute',
				top: 'calc(100% + 4px)',
				right: 0,
				display: 'flex',
				gap: '6px',
				padding: '6px',
				borderRadius: '10px',
				// A5: the expanded palette belongs to the same family as the control
				// that opens it, and now literally shares its tokens — the panel and the
				// control can no longer drift apart (the reviewer's own addition).
				background: 'var(--dsh-iq-surface-control)',
				border: '1px solid var(--dsh-iq-border-control)',
				boxShadow: 'var(--dsw-elevation-panel, 0 4px 12px rgba(16,24,40,.12))',
				zIndex: 5,
			},
			paletteOption: {
				width: '22px',
				height: '22px',
				borderRadius: '999px',
				border: '2px solid transparent',
				padding: 0,
				cursor: 'pointer',
			},
			noteRow: {
				display: 'flex',
				alignItems: 'center',
				gap: '10px',
				margin: '12px 16px 0',
			},
			noteLabel: {
				fontSize: '12px',
				color: 'var(--dsw-alias-label-secondary, #475467)',
				flexShrink: 0,
			},
			noteInput: {
				flex: 1,
				minWidth: 0,
				// `UI图.png`: the field's top and bottom borders sit at y=873 and
				// y=932, a 60 image px box (40 CSS px at the figure's 1.5 scale).
				height: '40px',
				padding: '0 10px',
				borderRadius: '8px',
				border: '1px solid var(--dsw-alias-border-l2, #eaecf0)',
				// A2: the note field takes the plugin's own input token rather than the
				// host overlay fill, which read as a light block on a dark card.
				background: 'var(--dsh-iq-surface-input)',
				color: 'inherit',
				font: '13px/1.5 ui-sans-serif, system-ui, sans-serif',
				boxSizing: 'border-box',
			},
			noteCount: {
				fontSize: '11px',
				color: 'var(--dsw-alias-label-caption, #667085)',
				flexShrink: 0,
				fontVariantNumeric: 'tabular-nums',
			},
			footer: {
				display: 'flex',
				alignItems: 'center',
				gap: '10px',
				flexWrap: 'wrap',
				margin: '14px 16px 0',
			},
			group: { display: 'flex', alignItems: 'center', gap: '6px' },
			groupLabel: {
				fontSize: '12px',
				color: 'var(--dsw-alias-label-tertiary, #475467)',
				whiteSpace: 'nowrap',
			},
			divider: {
				width: '1px',
				// `UI图.png`: the two rules span y=968-1010 (43 image px) and
				// y=971-1008 (38 image px); the mid value is 40.5 image px = 27 CSS px.
				height: '27px',
				// Both rules keep ~24 CSS px of air on their left, while the footer's
				// own gap is 10px, so the extra 14px belongs to the rule itself.
				margin: '0 14px',
				background: 'var(--dsw-alias-border-l2, #eaecf0)',
				flexShrink: 0,
			},
			segment: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '5px',
				// `UI图.png`: the armed 框选 chip is 101x47 image px (67.3x31.3 CSS px).
				height: '31px',
				padding: '0 9px',
				borderRadius: '8px',
				border: '1px solid transparent',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, #475467)',
				cursor: 'pointer',
				font: '500 12px/1 ui-sans-serif, system-ui, sans-serif',
				whiteSpace: 'nowrap',
			},
			segmentOn: {
				background: 'rgba(47,107,255,0.12)',
				borderColor: ACCENT,
				color: ACCENT,
			},
			verdict: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '5px',
				// Same row height as the tool chips in `UI图.png` (verdict dots and
				// chip glyphs share one baseline band).
				height: '31px',
				padding: '0 8px',
				borderRadius: '8px',
				border: '1px solid transparent',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, #475467)',
				cursor: 'pointer',
				font: '500 12px/1 ui-sans-serif, system-ui, sans-serif',
				whiteSpace: 'nowrap',
			},
			radioOuter: {
				width: '13px',
				height: '13px',
				borderRadius: '999px',
				border: '2px solid currentColor',
				display: 'grid',
				placeItems: 'center',
				flexShrink: 0,
				boxSizing: 'border-box',
			},
			radioInner: { width: '5px', height: '5px', borderRadius: '999px', background: 'currentColor' },
			pager: { display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' },
			progress: {
				color: 'var(--dsw-alias-label-secondary, #475467)',
				fontSize: '13px',
				fontWeight: 500,
				lineHeight: '24px',
				padding: '0 4px',
				whiteSpace: 'nowrap',
				wordSpacing: '-2px',
			},
			submit: {
				appearance: 'none',
				border: '1px solid ' + ACCENT,
				borderRadius: '8px',
				background: ACCENT,
				color: '#ffffff',
				// `UI图.png`: the blue fill is a 99x53 image px box = 66x35.5 CSS px.
				// 1px border + 7px padding each side plus a 13px/1.5 line box lands
				// on that height; 20px padding lands on that width.
				padding: '7px 20px',
				font: '600 13px/1.5 ui-sans-serif, system-ui, sans-serif',
				cursor: 'pointer',
				whiteSpace: 'nowrap',
			},
			error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #b42318)' },
			// M5: the render-failure card's bounded summary. Wraps instead of
			// overflowing, and stays one short line of tertiary text.
			failureSummary: {
				marginTop: '4px',
				fontSize: '11px',
				lineHeight: '16px',
				color: 'var(--dsw-alias-label-tertiary, #475467)',
				wordBreak: 'break-word',
				maxWidth: '520px',
			},
		};

		/**
		 * M3 card: one paged draft per question, two annotation tools, a verdict
		 * row, a note field, and the zoom / colour controls floating over the image
		 * area. The coordinate contract and fetch path are unchanged from M1.
		 */
		function ImageAnnotationComposer(props) {
			const pending = props.matched;
			const fetcher = props.fetcher;
			const questions = Array.isArray(pending.questions) ? pending.questions : [];
			// A chain entry that throws renders a dead cell WITHOUT abdicating (the
			// renderer passes `abdicate: spec.kind !== "chain"`), so an unusable
			// carrier or batch must degrade to a visible message, never an exception.
			if (typeof fetcher !== 'function' || questions.length === 0) {
				return h('div', { style: styles.frame },
					h('div', { style: styles.card, 'data-dsh-image-question': MARKER + '-degraded' },
						h('div', { style: Object.assign({}, styles.header, { alignItems: 'center' }) },
							h('div', { style: styles.error }, '图片提问卡初始化失败：HTTP 取图通道不可用。'),
							h('div', { style: styles.headerActions },
								h('button', {
									type: 'button',
									className: 'dsh-iq-icon',
									title: '关闭',
									onClick: () => { Promise.resolve(pending.cancel()).then(undefined, () => {}); },
									style: styles.iconButton,
								}, h(IconClose, { size: 16 }))
							)
						)
					)
				);
			}

			const [currentIndex, setCurrentIndex] = React.useState(0);
			// One draft per question, keyed by POSITION in the batch. Everything the
			// user does to a question is written into its own entry, so drafts[i] is
			// always the answer for questions[i] and never another question's work.
			const [drafts, setDrafts] = React.useState(() => questions.map(initialDraftFor));
			// `dragRect` and the brush stroke are in-flight interaction only; they are
			// deliberately not part of a draft, because an unfinished mark must not
			// survive a page change.
			const [dragRect, setDragRect] = React.useState(null);
			const [brushPreview, setBrushPreview] = React.useState(null);
			// 需求3: the polygon lasso while it is still open. `points` are the
			// vertices already written, `previewPoint` is where the cursor is now —
			// the rubber band. NONE of it is a mark: it reaches `annotations` only
			// through `commitAnnotation`, once, when the shape closes.
			const [lasso, setLasso] = React.useState(null);
			const [panning, setPanning] = React.useState(null);
			const [spaceDown, setSpaceDown] = React.useState(false);
			const [viewport, setViewport] = React.useState({ w: 0, h: 0 });
			// F1: the bitmap URL and the failure message are stored WITH the view
			// token they were fetched for, and the render below accepts them only
			// when that token is still the current question's. A stale entry is
			// therefore rejected at render time — an effect that clears it later
			// would leave exactly the window this fix removes.
			const [imageState, setImageState] = React.useState(null);
			const [imageErrorState, setImageErrorState] = React.useState(null);
			const [paletteOpen, setPaletteOpen] = React.useState(false);
			const [collapsed, setCollapsed] = React.useState(false);
			const [phase, setPhase] = React.useState('idle');
			const [errorText, setErrorText] = React.useState('');

			const viewportRef = React.useRef(null);
			const nextIdRef = React.useRef(1);
			const brushRef = React.useRef(null);
			const brushFrameRef = React.useRef(null);
			const paletteRef = React.useRef(null);
			// A gesture cut short by a page change, an undo, or a collapse leaves
			// its own `pointerup` / `pointercancel` still queued. The dropped id is
			// parked here so that trailing event is ignored instead of writing the
			// cleared state back through a handler closure that predates the drop.
			// Reset when the next gesture starts, never by the trailing event
			// itself: `pointercancel` and `pointerup` may both arrive.
			const droppedPointerRef = React.useRef(null);
			// The wheel and pointer handlers are bound once (wheel) or re-created per
			// render (pointer), so anything read across a page change must come from
			// a ref. The ref tracks the CLAMPED index, so a write can never land on a
			// question that is not the one on screen.
			const currentIndexRef = React.useRef(0);
			React.useEffect(() => {
				currentIndexRef.current = Math.min(currentIndex, questions.length - 1);
			});

			// Clamped defensively: a stale index must render a question, not throw.
			const index = Math.min(currentIndex, questions.length - 1);
			const question = questions[index];
			const spec = question.imageAnnotation;
			const source = { w: spec.image.sourceWidth, h: spec.image.sourceHeight };
			const viewToken = spec.image.viewToken;
			const current = drafts[index];
			const annotations = current.annotations;
			const view = current.view;
			const activeTool = current.activeTool;
			const palette = paletteOf(spec);
			const noteMax = noteMaxOf(spec);
			const allowedTools = toolsOf(spec);

			// Only the current question's own bytes may reach the <img>.
			const imageUrl = imageState !== null && imageState.token === viewToken ? imageState.url : null;
			const imageError = imageErrorState !== null && imageErrorState.token === viewToken
				? imageErrorState.message
				: null;

			/** Replace the draft of whichever question is current right now. */
			const patchCurrentDraft = (patch) => {
				const at = currentIndexRef.current;
				setDrafts((all) => all.map((entry, position) => (
					position === at ? Object.assign({}, entry, patch) : entry
				)));
			};

			/**
			 * The ONE commit point for a finished mark, and the only writer of a
			 * question's annotation list. One call = one undo step, so the argument is
			 * a COMPLETE entry: an unfinished gesture (a live brush stroke, a lasso
			 * that has not closed) is held outside the draft and becomes exactly one
			 * entry when it finishes. The step is recorded on THIS question's own
			 * stack, so two questions can never share a history.
			 */
			const commitAnnotation = (entry) => {
				const at = currentIndexRef.current;
				setDrafts((all) => all.map((item, position) => (
					position === at
						? Object.assign({}, item, {
							annotations: item.annotations.concat([entry]),
							undoStack: item.undoStack.concat([entry.id]),
						})
						: item
				)));
			};

			// Contain fit and the derived world transform, both from the registered
			// geometry module. `view` stores a zoom ratio plus the source point held
			// at the viewport center, so a window resize keeps that point under the
			// cursor instead of drifting with tx/ty.
			const transform = worldTransform(viewport, view, source);
			const { sFit, scale, tx, ty } = transform;

			// Pointer and wheel handlers read live geometry here, so they never close
			// over a stale transform. The border widths ride along because they belong
			// to the same coordinate contract: client points are measured from the
			// content-box corner, not from the border box the DOM rect reports.
			const geometryRef = React.useRef(null);
			React.useEffect(() => {
				const border = borderWidthsOf(viewportRef.current);
				geometryRef.current = {
					scale, tx, ty, sFit, viewport, view,
					borderX: border.x, borderY: border.y,
				};
			});

			const sourcePointOf = (event) => {
				const element = viewportRef.current;
				const geometry = geometryRef.current;
				if (element === null || geometry === null || geometry.scale <= 0) return null;
				const rect = element.getBoundingClientRect();
				// Measured from the CONTENT-box origin, which is where the world
				// transform actually starts; the border box that the DOM rect reports
				// lies `borderX/Y` outside it. Subtracting the raw rect alone WAS the
				// constant `borderWidth / scale` translation this repairs.
				const left = rect.left + geometry.borderX;
				const top = rect.top + geometry.borderY;
				return toSourcePoint(
					{ x: event.clientX, y: event.clientY },
					{ x: left, y: top },
					geometry,
					source,
				);
			};

			// Read the image through this plugin's own read-only view route. The
			// official session-authorized image route cannot serve an attachment
			// that never entered the session event stream, so that path asserted
			// ATTACHMENT_NOT_REFERENCED and left the card unable to draw.
			//
			// The bytes become one object URL owned by this effect; teardown both
			// aborts the fetch and revokes the URL. Every question carries its OWN
			// view token, so paging re-runs this effect with a different token.
			React.useEffect(() => {
				let alive = true;
				let objectUrl = null;
				const abort = new AbortController();
				// Drop an entry that belongs to a question we already left; the render
				// guard already ignores it, this just keeps state from accumulating.
				setImageState((previous) => (
					previous !== null && previous.token === viewToken ? previous : null
				));
				setImageErrorState(null);
				const url = new URL(VIEW_ROUTE_PATH, hostBase());
				url.searchParams.set('token', viewToken);
				Promise.resolve(fetcher(url, {
					method: 'GET',
					credentials: 'same-origin',
					signal: abort.signal,
				})).then((response) => {
					if (response === undefined || response === null || response.ok !== true) {
						throw new Error('HTTP ' + (response === undefined || response === null ? '?' : response.status));
					}
					return response.blob();
				}).then((blob) => {
					if (!alive) return;
					objectUrl = URL.createObjectURL(blob);
					setImageState({ token: viewToken, url: objectUrl });
				}).catch((error) => {
					if (!alive) return;
					// Teardown abort is normal, not a user-visible failure.
					if (error !== undefined && error !== null && error.name === 'AbortError') return;
					setImageErrorState({
						token: viewToken,
						message: error instanceof Error ? error.message : String(error),
					});
				});
				return () => {
					alive = false;
					abort.abort();
					if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
				};
			}, [viewToken, fetcher]);

			// Measure the viewport for the contain fit. `collapsed` belongs in the
			// dependency list because collapsing unmounts the viewport node: React
			// builds a FRESH one on expand, and only a re-run of this effect can
			// observe that node and measure it. `element` is captured so the cleanup
			// always targets the node this run bound, never whatever the ref happens
			// to hold later.
			React.useEffect(() => {
				if (collapsed) return undefined;
				const element = viewportRef.current;
				if (element === null) return undefined;
				const measure = () => setViewport({ w: element.clientWidth, h: element.clientHeight });
				measure();
				if (typeof ResizeObserver === 'function') {
					const observer = new ResizeObserver(measure);
					observer.observe(element);
					return () => observer.disconnect();
				}
				window.addEventListener('resize', measure);
				return () => window.removeEventListener('resize', measure);
			}, [collapsed]);

			// Space toggles pan mode; the card owns the key while it is on screen.
			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.code !== 'Space') return;
					const target = event.target;
					const typing = target !== null && target !== undefined && (
						target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true
					);
					if (typing) return;
					event.preventDefault();
					setSpaceDown(true);
				};
				const onKeyUp = (event) => {
					if (event.code === 'Space') setSpaceDown(false);
				};
				const onBlur = () => setSpaceDown(false);
				window.addEventListener('keydown', onKeyDown);
				window.addEventListener('keyup', onKeyUp);
				window.addEventListener('blur', onBlur);
				return () => {
					window.removeEventListener('keydown', onKeyDown);
					window.removeEventListener('keyup', onKeyUp);
					window.removeEventListener('blur', onBlur);
				};
			}, []);

			// Wheel zoom must call preventDefault, which React's synthetic wheel
			// listener cannot do (it is passive), so bind natively. `collapsed` is a
			// dependency for the same reason as the measurement effect: expanding
			// re-creates the viewport node, and a natively-bound listener does not
			// follow a node React replaced. The capture of `element` keeps the
			// removal pointed at the node this run bound.
			React.useEffect(() => {
				if (collapsed) return undefined;
				const element = viewportRef.current;
				if (element === null) return undefined;
				const onWheel = (event) => {
					const geometry = geometryRef.current;
					if (geometry === null || geometry.scale <= 0) return;
					event.preventDefault();
					const rect = element.getBoundingClientRect();
					// The same content-box origin as `sourcePointOf`: an anchor measured
					// from the border box would slide the image under a cursor that never
					// moved.
					const anchorX = event.clientX - rect.left - geometry.borderX;
					const anchorY = event.clientY - rect.top - geometry.borderY;
					// Source point currently under the cursor.
					const world = {
						x: (anchorX - geometry.tx) / geometry.scale,
						y: (anchorY - geometry.ty) / geometry.scale,
					};
					const factor = Math.exp(-event.deltaY * 0.0015);
					const zoomRatio = clamp(geometry.view.zoomRatio * factor, ZOOM_MIN, ZOOM_MAX);
					const nextScale = geometry.sFit * zoomRatio;
					// Hold `world` at the same viewport position.
					const nextTx = anchorX - world.x * nextScale;
					const nextTy = anchorY - world.y * nextScale;
					patchCurrentDraft({
						view: {
							zoomRatio,
							centerX: (geometry.viewport.w / 2 - nextTx) / nextScale,
							centerY: (geometry.viewport.h / 2 - nextTy) / nextScale,
						},
					});
				};
				element.addEventListener('wheel', onWheel, { passive: false });
				return () => element.removeEventListener('wheel', onWheel);
			}, [collapsed]);

			// A pending palette popover closes on any click outside the control.
			React.useEffect(() => {
				if (!paletteOpen) return undefined;
				const onDocDown = (event) => {
					const host = paletteRef.current;
					if (host !== null && event.target instanceof Node && host.contains(event.target)) return;
					setPaletteOpen(false);
				};
				document.addEventListener('pointerdown', onDocDown, true);
				return () => document.removeEventListener('pointerdown', onDocDown, true);
			}, [paletteOpen]);

			// An in-flight stroke owns a pending animation frame; drop it on unmount.
			React.useEffect(() => () => {
				if (brushFrameRef.current !== null) {
					cancelAnimationFrame(brushFrameRef.current);
					brushFrameRef.current = null;
				}
			}, []);

			const onPointerDown = (event) => {
				// A new gesture supersedes any dropped-pointer tombstone.
				droppedPointerRef.current = null;
				const element = viewportRef.current;
				if (element === null || imageUrl === null) return;
				const wantsPan = event.button === 1 || (event.button === 0 && spaceDown);
				if (wantsPan) {
					event.preventDefault();
					element.setPointerCapture(event.pointerId);
					const geometry = geometryRef.current;
					setPanning({
						pointerId: event.pointerId,
						startX: event.clientX,
						startY: event.clientY,
						startTx: geometry === null ? 0 : geometry.tx,
						startTy: geometry === null ? 0 : geometry.ty,
					});
					return;
				}
				if (event.button !== 0) return;
				const point = sourcePointOf(event);
				if (point === null) return;
				if (activeTool === 'brush') {
					// 需求3: an OPEN lasso owns every further left click — each one
					// writes a vertex, and a double click seals the shape instead of
					// writing it on. Nothing here re-runs the stroke/click split: once
					// the lasso exists, this gesture IS the lasso.
					if (lasso !== null) {
						if (event.detail === 2) {
							closeLasso(event.pointerId);
							return;
						}
						appendLassoVertex(point);
						return;
					}
					// No capture yet: the first press is only a CANDIDATE stroke. It
					// becomes either a stroke or the lasso's first vertex on pointerup,
					// and a lasso vertex needs no capture — see `onPointerMove`.
					element.setPointerCapture(event.pointerId);
					brushRef.current = {
						pointerId: event.pointerId,
						points: [point],
						startX: event.clientX,
						startY: event.clientY,
						// Bookkeeping only — never a veto (see BRUSH_MOVED_PX).
						moved: false,
					};
					setBrushPreview([point]);
					return;
				}
				element.setPointerCapture(event.pointerId);
				setDragRect({ pointerId: event.pointerId, x0: point.x, y0: point.y, x1: point.x, y1: point.y });
			};

			/** Write one more vertex on the open lasso. */
			const appendLassoVertex = (point) => {
				setLasso((value) => (value === null ? null : {
					points: value.points.concat([point]),
					previewPoint: null,
				}));
			};

			/**
			 * Seal the open lasso back to its first vertex and commit it as ONE
			 * complete mark — one call to the single commit point, hence one undo
			 * step. Fewer than three vertices is not a shape and is dropped. The
			 * `points` array repeats the first point instead of carrying a `closed`
			 * field, so the answer schema is untouched.
			 */
			const closeLasso = (pointerId) => {
				const open = lasso;
				setLasso(null);
				setBrushPreview(null);
				const element = viewportRef.current;
				if (element !== null && pointerId !== undefined && pointerId !== null
					&& element.hasPointerCapture(pointerId)) {
					element.releasePointerCapture(pointerId);
				}
				if (open === null || open.points.length < 3) return;
				const id = 'brush-' + nextIdRef.current;
				nextIdRef.current += 1;
				const ring = open.points.concat([open.points[0]]);
				commitAnnotation({
					id,
					type: 'brush',
					color: current.color,
					width: BRUSH_WIDTH_PX,
					points: ring.map((mark) => ({ x: mark.x, y: mark.y })),
				});
			};

			/**
			 * The right button closes the polygon, and the browser menu is suppressed
			 * here because the viewport owns this gesture. A right click never pans
			 * (`onPointerDown` returns on any non-left button) and never writes a
			 * vertex of its own.
			 */
			const onContextMenu = (event) => {
				event.preventDefault();
				if (lasso === null) return;
				closeLasso();
			};

			const onPointerMove = (event) => {
				// Same tombstone as `endPointer`: a move delivered after the drop
				// must not revive the gesture it belonged to.
				if (event.pointerId === droppedPointerRef.current) return;
				const stroke = brushRef.current;
				if (stroke !== null && stroke.pointerId === event.pointerId) {
					// Bookkeeping: this press has travelled far enough on screen to be a
					// drag. It decides NOTHING — the sampled point count does.
					const travelX = event.clientX - stroke.startX;
					const travelY = event.clientY - stroke.startY;
					if (!stroke.moved && travelX * travelX + travelY * travelY >= BRUSH_MOVED_PX * BRUSH_MOVED_PX) {
						stroke.moved = true;
					}
					const point = sourcePointOf(event);
					if (point === null) return;
					const geometry = geometryRef.current;
					const live = geometry === null || geometry.scale <= 0 ? 1 : geometry.scale;
					// Sample by ON-SCREEN distance, so a slow drag and a fast one
					// produce the same density at any zoom level.
					const minStep = BRUSH_MIN_STEP_PX / live;
					const last = stroke.points[stroke.points.length - 1];
					if (last !== undefined) {
						const dx = point.x - last.x;
						const dy = point.y - last.y;
						if (dx * dx + dy * dy < minStep * minStep) return;
					}
					if (stroke.points.length >= BRUSH_MAX_POINTS) return;
					stroke.points.push(point);
					// Coalesce repaints: a high-rate mouse must not drive one render
					// per event.
					if (brushFrameRef.current === null) {
						brushFrameRef.current = requestAnimationFrame(() => {
							brushFrameRef.current = null;
							const live2 = brushRef.current;
							if (live2 !== null) setBrushPreview(live2.points.slice());
						});
					}
					return;
				}
				if (lasso !== null) {
					// The rubber band rides ORDINARY moves: a written vertex released the
					// capture, and the viewport is itself the pointer event node, so the
					// band keeps up without holding the pointer down. Once the cursor
					// leaves the viewport there are no events at all and the band stops —
					// that is the element event model, not something this card can fix.
					const point = sourcePointOf(event);
					if (point === null) return;
					setLasso((value) => (value === null ? null : Object.assign({}, value, { previewPoint: point })));
					return;
				}
				if (panning !== null && panning.pointerId === event.pointerId) {
					const geometry = geometryRef.current;
					if (geometry === null || geometry.scale <= 0) return;
					const nextTx = panning.startTx + (event.clientX - panning.startX);
					const nextTy = panning.startTy + (event.clientY - panning.startY);
					patchCurrentDraft({
						view: {
							zoomRatio: geometry.view.zoomRatio,
							centerX: (geometry.viewport.w / 2 - nextTx) / geometry.scale,
							centerY: (geometry.viewport.h / 2 - nextTy) / geometry.scale,
						},
					});
					return;
				}
				if (dragRect !== null && dragRect.pointerId === event.pointerId) {
					const point = sourcePointOf(event);
					if (point === null) return;
					setDragRect({
						pointerId: dragRect.pointerId,
						x0: dragRect.x0,
						y0: dragRect.y0,
						x1: point.x,
						y1: point.y,
					});
				}
			};

			const endPointer = (event) => {
				// The gesture's own trailing up / cancel after a drop: ignore it
				// rather than re-release a capture that is already gone, or commit a
				// mark that was deliberately discarded.
				if (event.pointerId === droppedPointerRef.current) return;
				const element = viewportRef.current;
				const release = () => {
					if (element !== null && element.hasPointerCapture(event.pointerId)) {
						element.releasePointerCapture(event.pointerId);
					}
				};
				const stroke = brushRef.current;
				if (stroke !== null && stroke.pointerId === event.pointerId) {
					release();
					brushRef.current = null;
					if (brushFrameRef.current !== null) {
						cancelAnimationFrame(brushFrameRef.current);
						brushFrameRef.current = null;
					}
					setBrushPreview(null);
					const geometry = geometryRef.current;
					const live = geometry === null || geometry.scale <= 0 ? 1 : geometry.scale;
					// One simplification pass at commit time, tolerated in on-screen
					// pixels so the stroke looks the same at every zoom level.
					const simplified = rdpSimplify(stroke.points, RDP_EPSILON_PX / live);
					if (simplified.length >= 2) {
						// 需求3: the POINT COUNT decides. Two or more sampled points are a
						// stroke even when the press travelled less than BRUSH_MOVED_PX on
						// screen — a short stroke must never be reclassified into a click.
						const id = 'brush-' + nextIdRef.current;
						nextIdRef.current += 1;
						const color = current.color;
						commitAnnotation({
							id,
							type: 'brush',
							color,
							width: BRUSH_WIDTH_PX,
							points: simplified.map((point) => ({ x: point.x, y: point.y })),
						});
					} else {
						// A single point is not a stroke: it opens the polygon lasso, and
						// that point is its first vertex. Nothing is committed yet, and no
						// capture is held — see `onPointerMove`.
						setLasso({ points: stroke.points.slice(0, 1), previewPoint: null });
					}
					return;
				}
				if (panning !== null && panning.pointerId === event.pointerId) {
					release();
					setPanning(null);
					return;
				}
				if (dragRect !== null && dragRect.pointerId === event.pointerId) {
					release();
					const rect = rectOf(dragRect);
					setDragRect(null);
					if (rect.width >= MIN_RECT_SOURCE_PX && rect.height >= MIN_RECT_SOURCE_PX) {
						const id = 'rect-' + nextIdRef.current;
						nextIdRef.current += 1;
						const color = current.color;
						// Commits to the CURRENT question's own list, and to its own stack.
						commitAnnotation({ id, type: 'rect', color, rect });
					}
				}
			};

			/**
			 * Drop every in-flight interaction AND release the pointer capture it
			 * holds. An unfinished mark belongs to the node and the question it
			 * started on, so a page change, an undo, and a collapse must all
			 * discard it — resuming it later would draw into the wrong question, or
			 * onto a node that no longer exists.
			 *
			 * `goTo` and `undo` leave the viewport mounted, so nothing else would
			 * release the capture: the element stays the capture target until the
			 * user lifts the pointer, and every move in between is delivered to a
			 * gesture that no longer exists. `toggleCollapsed` does unmount the node
			 * (the browser releases the capture with it), but the release here runs
			 * first and covers all three paths under one rule.
			 *
			 * The id must be read BEFORE the state below is cleared, because it lives
			 * in that state: the stroke's ref, or `panning` / `dragRect` of this
			 * render. `hasPointerCapture` guards the call — releasing an id this
			 * element does not hold throws — and every entry point (a button click, a
			 * key press) can run with no gesture in flight at all.
			 */
			const dropTransientInteraction = () => {
				const pointerId = brushRef.current !== null
					? brushRef.current.pointerId
					: panning !== null
						? panning.pointerId
						: dragRect !== null
							? dragRect.pointerId
							: null;
				const element = viewportRef.current;
				if (pointerId !== null && element !== null && element.hasPointerCapture(pointerId)) {
					element.releasePointerCapture(pointerId);
				}
				// Tombstone: the dropped gesture's trailing up / cancel is ignored.
				droppedPointerRef.current = pointerId;
				brushRef.current = null;
				if (brushFrameRef.current !== null) {
					cancelAnimationFrame(brushFrameRef.current);
					brushFrameRef.current = null;
				}
				setBrushPreview(null);
				setDragRect(null);
				setPanning(null);
				// 需求3: an open lasso is in-flight state like any other. Every discard
				// entry drops it, so no vertex and no rubber band survives a page
				// change, a collapse, a submit or an undo.
				setLasso(null);
			};

			/** Switch the visible question, dropping anything that belongs to the old one. */
			const goTo = (next) => {
				const bounded = clamp(next, 0, questions.length - 1);
				if (bounded === index) return;
				dropTransientInteraction();
				setPaletteOpen(false);
				setCurrentIndex(bounded);
			};

			/**
			 * Collapse / expand. The in-flight mark is discarded here exactly as a
			 * page change discards it, and `dropTransientInteraction` releases the
			 * pointer capture while the node is still mounted. Collapsing then unmounts
			 * the viewport, which would end the capture anyway — the explicit release
			 * exists so all three entry points share one rule, not because the unmount
			 * is insufficient. Both viewport effects depend on `collapsed`, so expanding
			 * re-binds the native wheel listener and re-measures the fresh node.
			 */
			const toggleCollapsed = () => {
				dropTransientInteraction();
				setPaletteOpen(false);
				setCollapsed((value) => !value);
			};

			/** Scale about the viewport centre; the stored centre point is unchanged. */
			const zoomBy = (factor) => {
				const geometry = geometryRef.current;
				if (geometry === null) return;
				patchCurrentDraft({
					view: {
						zoomRatio: clamp(geometry.view.zoomRatio * factor, ZOOM_MIN, ZOOM_MAX),
						centerX: geometry.view.centerX,
						centerY: geometry.view.centerY,
					},
				});
			};

			const fitView = () => {
				patchCurrentDraft({
					view: { zoomRatio: 1, centerX: source.w / 2, centerY: source.h / 2 },
				});
			};

			/**
			 * 撤销: step THIS question back by one committed mark, leaving its other
			 * fields alone. The in-flight gesture is discarded first — it is not a
			 * step yet and must not be one — then the newest step is popped by id.
			 * Repeating it walks the marks back until the question is empty; an empty
			 * stack is a no-op (the button is disabled, so this only guards a stray
			 * call, e.g. a queued click that lands after the last step).
			 */
			const undo = () => {
				dropTransientInteraction();
				const at = currentIndexRef.current;
				setDrafts((all) => all.map((item, position) => {
					if (position !== at || item.undoStack.length === 0) return item;
					const lastId = item.undoStack[item.undoStack.length - 1];
					return Object.assign({}, item, {
						annotations: item.annotations.filter((mark) => mark.id !== lastId),
						undoStack: item.undoStack.slice(0, -1),
					});
				}));
			};

			const setNote = (value) => {
				const text = value.length > noteMax ? value.slice(0, noteMax) : value;
				patchCurrentDraft({ note: text });
			};

			// One submission carries one answer per question, each built from that
			// question's OWN draft — no answer ever reuses another question's marks.
			const submit = () => {
				if (phase === 'submitting' || phase === 'done') return;
				// P2: a submission ends the interaction exactly as an undo or a page
				// change does, so it drops the in-flight mark — and releases its pointer
				// capture — BEFORE the answers are built. The snapshot submitted is
				// therefore always taken from a terminated draft, and the four discard
				// entry points (`goTo` / `undo` / `toggleCollapsed` / `submit`) share
				// one rule instead of three plus a hole.
				dropTransientInteraction();
				setPhase('submitting');
				const answers = questions.map((entry, position) => {
					const own = drafts[position];
					return {
						id: entry.id,
						selected: [VERDICT_LABEL[own.verdict]],
						custom: JSON.stringify(buildAnswerPayload(entry, own)),
					};
				});
				Promise.resolve(pending.answer({ answers })).then(() => {
					setPhase('done');
				}, (error) => {
					setPhase('error');
					setErrorText(error instanceof Error ? error.message : String(error));
				});
			};

			const cancel = () => {
				if (phase === 'submitting' || phase === 'done') return;
				Promise.resolve(pending.cancel()).then(undefined, (error) => {
					setPhase('error');
					setErrorText(error instanceof Error ? error.message : String(error));
				});
			};

			const dragPreview = dragRect === null ? null : rectOf(dragRect);
			const busy = phase === 'submitting' || phase === 'done';
			const cursor = panning !== null ? 'grabbing' : spaceDown ? 'grab' : 'crosshair';

			const shapes = [];
			for (const entry of annotations) {
				if (entry.type === 'brush') {
					shapes.push(h('polyline', {
						key: entry.id,
						points: entry.points.map((point) => point.x + ',' + point.y).join(' '),
						fill: 'none',
						stroke: entry.color,
						// Authored in source units so the on-screen stroke keeps a
						// constant thickness at every zoom level.
						strokeWidth: entry.width / scale,
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
					}));
					continue;
				}
				shapes.push(h('rect', {
					key: entry.id,
					x: entry.rect.x,
					y: entry.rect.y,
					width: entry.rect.width,
					height: entry.rect.height,
					fill: 'none',
					stroke: entry.color,
					strokeWidth: 2 / scale,
				}));
			}
			if (brushPreview !== null && brushPreview.length > 1) {
				shapes.push(h('polyline', {
					key: 'stroke',
					points: brushPreview.map((point) => point.x + ',' + point.y).join(' '),
					fill: 'none',
					stroke: current.color,
					strokeWidth: BRUSH_WIDTH_PX / scale,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					opacity: 0.9,
				}));
			}
			if (lasso !== null) {
				// 需求3: the shape as far as it is written, plus the rubber band from
				// the last vertex to the cursor. Both are PREVIEW only — the mark is
				// created by `closeLasso`, once, through `commitAnnotation`.
				if (lasso.points.length >= 2) {
					shapes.push(h('polyline', {
						key: 'lasso',
						points: lasso.points.map((point) => point.x + ',' + point.y).join(' '),
						fill: 'none',
						stroke: current.color,
						strokeWidth: BRUSH_WIDTH_PX / scale,
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
						opacity: 0.9,
					}));
				}
				const lastVertex = lasso.points[lasso.points.length - 1];
				if (lasso.previewPoint !== null && lastVertex !== undefined) {
					shapes.push(h('polyline', {
						key: 'lasso-rubber',
						points: lastVertex.x + ',' + lastVertex.y + ' '
							+ lasso.previewPoint.x + ',' + lasso.previewPoint.y,
						fill: 'none',
						stroke: current.color,
						strokeWidth: BRUSH_WIDTH_PX / scale,
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
						strokeDasharray: (6 / scale) + ' ' + (4 / scale),
						opacity: 0.5,
					}));
				}
			}
			if (dragPreview !== null) {
				shapes.push(h('rect', {
					key: 'draft',
					x: dragPreview.x,
					y: dragPreview.y,
					width: dragPreview.width,
					height: dragPreview.height,
					fill: 'rgba(255,59,48,0.14)',
					stroke: current.color,
					strokeWidth: 1.5 / scale,
					strokeDasharray: (6 / scale) + ' ' + (4 / scale),
				}));
			}

			const world = h('div', {
				style: Object.assign({}, styles.world, {
					transform: 'matrix(' + scale + ',0,0,' + scale + ',' + tx + ',' + ty + ')',
				}),
			},
				h('img', {
					src: imageUrl === null ? undefined : imageUrl,
					alt: question.question === undefined ? '' : String(question.question),
					draggable: false,
					// The CSS box is the SOURCE size even when the stored raster is
					// smaller, which makes the world layer the source coordinate space.
					style: Object.assign({}, styles.image, { width: source.w, height: source.h }),
				}),
				h('svg', {
					viewBox: '0 0 ' + source.w + ' ' + source.h,
					width: source.w,
					height: source.h,
					style: styles.overlay,
				}, shapes)
			);

			const canPrev = index > 0 && !busy;
			const canNext = index < questions.length - 1 && !busy;
			// The pager only appears for a real batch, so a single-question request
			// still looks exactly as it did in M1. Both ends are DISABLED rather
			// than wrapped around, so the user can always tell they are at an edge.
			const pager = questions.length > 1
				? h('div', { style: styles.pager },
					h('button', {
						type: 'button',
						className: 'dsh-iq-icon',
						title: '上一题',
						onClick: () => goTo(index - 1),
						disabled: !canPrev,
						style: Object.assign({}, styles.iconButton, { color: canPrev ? styles.iconButton.color : 'var(--dsw-alias-label-dimmed, #98a2b3)' }),
					}, h(IconChevronLeft, { size: 16 })),
					h('span', { style: styles.progress }, (index + 1) + ' / ' + questions.length),
					h('button', {
						type: 'button',
						className: 'dsh-iq-icon',
						title: '下一题',
						onClick: () => goTo(index + 1),
						disabled: !canNext,
						style: Object.assign({}, styles.iconButton, { color: canNext ? styles.iconButton.color : 'var(--dsw-alias-label-dimmed, #98a2b3)' }),
					}, h(IconChevronRight, { size: 16 }))
				)
				: null;

			const submitLabel = phase === 'done'
				? '已提交'
				: phase === 'submitting'
					? '提交中…'
					: '提交';

			/**
			 * `iconColor` is passed for the rect tool ONLY: C1 wants that one glyph in
			 * the current annotation colour, while the brush and undo icons stay
			 * light (the figure draws them that way). The chip's own border and label
			 * still follow the armed state.
			 */
			const toolSegment = (tool, label, icon, iconColor) => {
				const on = activeTool === tool;
				return h('button', {
					type: 'button',
					key: tool,
					className: 'dsh-iq-seg',
					onClick: () => patchCurrentDraft({ activeTool: tool }),
					disabled: busy,
					style: on ? Object.assign({}, styles.segment, styles.segmentOn) : styles.segment,
				}, h(icon, iconColor === undefined ? { size: 14 } : { size: 14, color: iconColor }), label);
			};

			const verdictChoice = (value) => {
				const on = current.verdict === value;
				const tone = value === 'ng'
					? 'var(--dsw-alias-state-error-primary, #ff3b30)'
					: 'currentColor';
				return h('button', {
					type: 'button',
					key: value,
					className: 'dsh-iq-verdict',
					onClick: () => patchCurrentDraft({ verdict: value }),
					disabled: busy,
					style: Object.assign({}, styles.verdict, on ? { color: tone } : null),
				},
					h('span', { style: styles.radioOuter }, on ? h('span', { style: styles.radioInner }) : null),
					VERDICT_LABEL[value]);
			};

			// A4/B2: the readout strip (source size / zoom / mark count) is removed —
			// the figure does not draw it. The fetch-failure line is NOT a reading: it
			// is the visible degraded state the card must keep.
			const imageErrorNotice = imageError === null
				? null
				: h('div', { style: styles.imageErrorNotice }, '取图失败：' + imageError);

			const body = collapsed ? null : h('div', null,
				h('div', { style: styles.imageRow },
					h('div', {
						ref: viewportRef,
						style: Object.assign({}, styles.viewport, { cursor }),
						onPointerDown,
						onPointerMove,
						onPointerUp: endPointer,
						onPointerCancel: endPointer,
						// 需求3: the right button seals an open lasso, and the browser
						// menu must not appear over the picture.
						onContextMenu,
					}, world, imageErrorNotice),
					h('div', { style: styles.zoomToolbar },
						h('button', {
							type: 'button',
							className: 'dsh-iq-icon dsh-iq-zoom',
							title: '放大',
							onClick: () => zoomBy(ZOOM_BUTTON_FACTOR),
							disabled: busy,
							style: styles.zoomButton,
						}, h(IconZoomIn, { size: 15 })),
						h('button', {
							type: 'button',
							className: 'dsh-iq-icon dsh-iq-zoom',
							title: '缩小',
							onClick: () => zoomBy(1 / ZOOM_BUTTON_FACTOR),
							disabled: busy,
							style: styles.zoomButton,
						}, h(IconZoomOut, { size: 15 })),
						h('button', {
							type: 'button',
							className: 'dsh-iq-icon dsh-iq-zoom',
							title: '适应',
							onClick: fitView,
							disabled: busy,
							style: styles.zoomButton,
						}, h(IconFit, { size: 15 }))
					),
					h('div', { ref: paletteRef, style: styles.colorControl },
						// P8: no "标注颜色" label — the figure shows the swatch alone.
						h('button', {
							type: 'button',
							className: 'dsh-iq-swatch',
							title: '选择标注颜色',
							onClick: () => setPaletteOpen((open) => !open),
							disabled: busy,
							style: styles.swatch,
						},
							h('span', { style: Object.assign({}, styles.swatchDot, { background: current.color }) }),
							h('span', { style: styles.swatchCaret }, h(IconChevronDown, { size: 12 }))),
						paletteOpen ? h('div', { style: styles.palettePanel },
							palette.map((color) => h('button', {
								type: 'button',
								key: color,
								className: 'dsh-iq-option',
								title: color,
								onClick: () => {
									patchCurrentDraft({ color });
									setPaletteOpen(false);
								},
								style: Object.assign({}, styles.paletteOption, {
									background: color,
									borderColor: color === current.color
										? 'var(--dsw-alias-label-primary, #101828)'
										: 'transparent',
								}),
							})))
							: null
					)
				),
				h('div', { style: styles.noteRow },
					h('span', { style: styles.noteLabel }, '说明'),
					h('input', {
						type: 'text',
						className: 'dsh-iq-note',
						placeholder: '请输入说明...',
						value: current.note,
						maxLength: noteMax,
						disabled: busy,
						onChange: (event) => setNote(event.target.value),
						style: styles.noteInput,
					}),
					h('span', { style: styles.noteCount }, current.note.length + '/' + noteMax)
				),
				h('div', { style: styles.footer },
					h('div', { style: styles.group },
						h('span', { style: styles.groupLabel }, '标注工具'),
						allowedTools.indexOf('rect') >= 0 ? toolSegment('rect', '框选', IconRectTool, current.color) : null,
						allowedTools.indexOf('brush') >= 0 ? toolSegment('brush', '画笔', IconBrushTool) : null,
						h('button', {
							type: 'button',
							className: 'dsh-iq-seg',
							title: '撤销上一步标注',
							onClick: undo,
							disabled: busy || current.undoStack.length === 0,
							style: styles.segment,
						}, h(IconRedraw, { size: 14 }), '撤销')
					),
					h('span', { style: styles.divider }),
					h('div', { style: styles.group },
						h('span', { style: styles.groupLabel }, '判定结果'),
						VERDICT_ORDER.map(verdictChoice)
					),
					h('span', { style: styles.divider }),
					pager,
					h('button', {
						type: 'button',
						className: 'dsh-iq-submit',
						onClick: submit,
						disabled: busy,
						style: styles.submit,
					}, submitLabel),
					phase === 'error' ? h('span', { style: styles.error }, errorText) : null
				)
			);

			return h('div', { style: styles.frame },
				h('div', { style: styles.card, 'data-dsh-image-question': MARKER },
					h('div', { style: styles.header },
						h('div', { style: styles.headingBlock },
							h('div', { style: styles.eyebrow },
								// B1: exactly ONE span. The figure shows a single eyebrow, and
								// rendering the constant beside the request's own header is what
								// produced "NG 标注 NG 标注" whenever the two agreed. The fallback
								// is a constant because the request protocol carries no eyebrow
								// field today — a supplied `header` simply replaces it.
								h('span', null, typeof question.header === 'string' && question.header !== ''
									? question.header
									: DEFAULT_EYEBROW)),
							h('div', { style: styles.title }, String(question.question === undefined ? '' : question.question))
						),
						h('div', { style: styles.headerActions },
							h('button', {
								type: 'button',
								className: 'dsh-iq-icon',
								title: collapsed ? '展开' : '收起',
								onClick: toggleCollapsed,
								style: styles.iconButton,
							// B4: the figure's expanded card shows a DOWN chevron (「收起」); the
							// collapsed card points the other way. A checkmark said nothing
							// about either direction.
							}, collapsed ? h(IconChevronUp, { size: 16 }) : h(IconChevronDown, { size: 16 })),
							h('button', {
								type: 'button',
								className: 'dsh-iq-icon',
								title: '关闭',
								onClick: cancel,
								disabled: busy,
								style: styles.iconButton,
							}, h(IconClose, { size: 16 }))
						)
					),
					body
				)
			);
		}

		/**
		 * M5 fallback for a render that threw. A chain entry does NOT abdicate on a
		 * throw — the renderer's gate is `spec.kind !== "chain"` — so an exception
		 * here would leave a dead cell instead of falling back to the official card.
		 * This card is therefore the visible, escapable outcome: it states the
		 * failure, shows a bounded summary, and offers the one action that always
		 * works, `pending.cancel()` (the standard ASK_CANCELLED path).
		 *
		 * It deliberately touches nothing but `styles`, one string and `cancel`: the
		 * state that broke the real card must not be dereferenced a second time here.
		 */
		function RenderFailureCard(props) {
			const pending = props.pending;
			const summary = typeof props.summary === 'string' && props.summary !== ''
				? props.summary
				: '未提供错误摘要';
			return h('div', { style: styles.frame },
				h('div', { style: styles.card, 'data-dsh-image-question': MARKER + '-render-error' },
					h('div', { style: Object.assign({}, styles.header, { alignItems: 'center' }) },
						h('div', null,
							h('div', { style: styles.error }, '图片提问卡渲染失败，本次提问无法在这张卡片里完成。'),
							h('div', { style: styles.failureSummary }, '原因：' + summary)
						),
						h('div', { style: styles.headerActions },
							h('button', {
								type: 'button',
								className: 'dsh-iq-icon',
								title: '关闭',
								onClick: () => {
									try {
										Promise.resolve(pending.cancel()).then(undefined, () => {});
									} catch {
										// A cancel that throws synchronously is still not a render
										// failure: swallow it so this card stays renderable.
									}
								},
								style: styles.iconButton,
							}, h(IconClose, { size: 16 }))
						)
					)
				)
			);
		}

		/**
		 * M5 error boundary around the whole card.
		 *
		 * A `try`/`catch` inside the component body cannot do this job: React runs a
		 * function component during its own render phase, so a throw inside it never
		 * passes through the caller's stack — and catching one AFTER some of its hooks
		 * have already run would change the hook count on the next render.
		 * `getDerivedStateFromError` is the mechanism that actually covers a whole
		 * render subtree, so the boundary is a class component that renders the real
		 * card as its child and replaces it on failure.
		 */
		class ImageAnnotationBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { summary: null };
			}

			static getDerivedStateFromError(error) {
				return { summary: summarizeFailure(error) };
			}

			componentDidCatch() {
				// Scope first, then count, so this failure is charged to the request
				// that actually produced it and never to a leftover count from another.
				const token = firstViewTokenOf(this.props.matched);
				scopeRenderFailureTo(token);
				renderFailureCount += 1;
				if (renderFailureCount >= FAILURES_BEFORE_ABDICATION) {
					// Persistent breakage of THIS request: stop taking it over and let the
					// official card serve it instead of showing another dead cell. The
					// marker is keyed by the same token the count was charged to.
					abdicated = true;
					abdicatedToken = token;
				}
			}

			render() {
				if (this.state.summary === null) return h(ImageAnnotationComposer, this.props);
				return h(RenderFailureCard, { summary: this.state.summary, pending: this.props.matched });
			}
		}

		function apply(ctx) {
			ensureStyle();
			ctx.slots.inject('conversation.composer', () => ctx.slots.register({
				name: 'conversation.composer',
				// Ascending election: the lowest priority renders first, so the
				// official entry (priority 0) is only reached when this declines.
				priority: -100,
				select: (owner) => {
					const pending = owner.pendingInteraction;
					// Must be an explicit `return null`: the election treats anything
					// that is not `null` as a successful takeover.
					if (!isImageAnnotationPending(pending)) return null;
					const token = firstViewTokenOf(pending);
					// M5: a request that already broke the renderer twice is left to the
					// official card, for as long as the election keeps offering THAT
					// request.
					if (abdicated && token === abdicatedToken) return null;
					if (abdicated) {
						// A request carrying a different view token clears the flag, so the
						// plugin gets a fresh chance instead of staying disabled for the
						// rest of the session.
						abdicated = false;
						abdicatedToken = null;
					}
					// Serving a request re-points the counter at it, so every request starts
					// from a clean budget even when the previous one had already failed once
					// without reaching abdication.
					scopeRenderFailureTo(token);
					return pending;
				},
				// The browser HTTP carrier, injected so a verifier can substitute a
				// stub — the same injection shape the platform's own download route
				// uses for its fetcher.
				inject: () => ({ fetcher: (input, init) => fetch(input, init) }),
			}, ImageAnnotationBoundary));
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
