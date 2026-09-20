/**
 * HOST half of dsh-image-question.
 *
 * An attachment admitted through `ctx.attachments.saveImage()` never enters the
 * session event stream, so the official session-authorized image route cannot
 * serve it (`referencedImage()` scans session events and raises
 * ATTACHMENT_NOT_REFERENCED). The browser half therefore reads images through
 * this plugin's own read-only view route — the same exact-Fetch-route mechanism
 * `@deepseek-ai/dsh-session-log-export` uses — carrying one opaque capability
 * token per image.
 *
 * The token table is only an authorization mapping layered over the existing
 * attachment store: it mints a token immediately before `ask()`, serves bytes
 * by reading that same reference back, and revokes on settle. It is explicitly
 * NOT a second image library, upload endpoint, file cache, or normalization
 * pipeline, and it never accepts a filesystem path.
 *
 * Zero peer dependencies by design: the tool is registered with a raw
 * JSON-Schema definition, so nothing from `@deepseek-ai/dsh-tools` is imported.
 * Only Node built-ins (`node:crypto`, `node:fs/promises`, `node:path`) are used.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInFlightGuard } from './concurrency.js';
import { createViewTokenStore } from './token-store.js';

const TOOL_NAME = 'ask_user_question_image';
const REQUEST_SCHEMA = 'dsh.image-annotation.request/v1';
const COORDINATE_SPACE = 'source-oriented-pixel-edge';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const NOTE_MAX_LENGTH = 200;
/**
 * A6/P6: the figure samples the annotation colour at rgb(250,2,2). The client
 * mirrors this value as its own default, and `initialDraftFor` only adopts
 * `DEFAULT_COLOR` when the request's palette actually contains it — so the two
 * halves must agree or the card would fall back to this palette's first entry.
 */
const DEFAULT_PALETTE = ['#fa0202', '#ffcc00', '#34c759', '#0a84ff'];
/**
 * Exact Fetch route the browser half reads the image through. Host/Origin
 * fencing and browser authentication are applied by Connection before this
 * handler runs; the handler itself recognizes nothing but an opaque token.
 */
const VIEW_ROUTE_PATH = '/api/image-question.view';
/**
 * Token lifetime and the single-flight table live in their own modules so each
 * can be exercised without a Host: `./token-store.js` owns the capability table
 * and `./concurrency.js` owns agent identity plus claim / release.
 */
/**
 * B11: one outstanding image question per agent. A second concurrent call from
 * the SAME agent is refused before anything is read, so a refused call cannot
 * leave an orphaned attachment or an unanswered card behind.
 */
const BUSY_CODE = 'IMAGE_ANNOTATION_BUSY';
const MEDIA_TYPE_BY_EXTENSION = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

function mediaTypeOf(filePath) {
	const lower = String(filePath).toLowerCase();
	for (const extension of Object.keys(MEDIA_TYPE_BY_EXTENSION)) {
		if (lower.endsWith(extension)) return MEDIA_TYPE_BY_EXTENSION[extension];
	}
	return undefined;
}

/** Compose the caller's cancellation signal with an absolute deadline. */
function composeSignal(callerSignal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (callerSignal === undefined) return timeout;
	return AbortSignal.any([callerSignal, timeout]);
}

/** A failure is reported to the model as data, never as an aborted tool call. */
function failureOf(error) {
	if (error instanceof Error) {
		return { name: error.name, code: error.code, message: error.message };
	}
	return { name: 'Error', message: String(error) };
}

/**
 * Drop `undefined` keys before the reference becomes wire payload. The Remote
 * wire projection rejects the entire request on one non-lossless-JSON own
 * value, and `originalDimensions`/`name` are optional on a stored reference.
 */
function losslessRef(ref) {
	const out = {};
	for (const key of Object.keys(ref)) {
		const value = ref[key];
		if (value === undefined) continue;
		if (key === 'originalDimensions' && value !== null && typeof value === 'object') {
			out.originalDimensions = { width: value.width, height: value.height };
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * Source-space dimensions, following DSH's own semantics rather than a local
 * EXIF rule: `ref.width/height` is the stored normalized raster, and
 * `originalDimensions` is the EXIF-applied, pre-scaling size that appears only
 * when normalization reduced the image.
 */
function dimensionsOf(ref) {
	const original = ref.originalDimensions;
	return {
		// `== null` matches the doc's literal `ref.originalDimensions ?? ref.width`
		// fallback, so an absent OR explicitly null field both use the stored size.
		sourceWidth: original == null ? ref.width : original.width,
		sourceHeight: original == null ? ref.height : original.height,
		storedWidth: ref.width,
		storedHeight: ref.height,
	};
}

/** Read one image file and durably admit it, mapping failures to clear errors. */
async function admitImage(ctx, filePath) {
	const mediaType = mediaTypeOf(filePath);
	if (mediaType === undefined) {
		throw Object.assign(
			new Error(`unsupported image extension for ${filePath}; expected .png, .jpg, .jpeg, .webp, or .gif`),
			{ code: 'UNSUPPORTED_MEDIA_TYPE' },
		);
	}
	let bytes;
	try {
		bytes = await readFile(filePath);
	} catch (error) {
		throw Object.assign(
			new Error(`cannot read image ${filePath}: ${error instanceof Error ? error.message : String(error)}`),
			{ code: 'IMAGE_READ_FAILED' },
		);
	}
	try {
		return await ctx.attachments.saveImage({
			data: new Uint8Array(bytes),
			mediaType,
			name: basename(filePath),
		});
	} catch (error) {
		throw Object.assign(
			new Error(`the attachment service rejected ${filePath}: ${error instanceof Error ? error.message : String(error)}`),
			{ code: 'IMAGE_ADMISSION_FAILED' },
		);
	}
}

/** The Host Connection service whose exact Fetch routes serve this plugin. */
function connectionOf(ctx) {
	return Reflect.get(ctx, 'connection');
}

export const name = 'image-question';
export const inject = ['tools', 'userQuestions', 'attachments', 'connection'];

/**
 * Register the read-only view route and the tool.
 *
 * The route serves one already-admitted attachment by opaque capability token.
 * Connection applies the Host/Origin fence and browser authentication before
 * this handler runs, and `fetch.register` owns its own fiber effect, so the
 * route disappears with this plugin.
 */
export function apply(ctx) {
	// Authorized byte reads for one request: the capability table lives in
	// `./token-store.js`, one instance per plugin `apply()`.
	const viewTokens = createViewTokenStore();
	// B11 serialization of one agent's calls: the table and its identity keys live
	// in `./concurrency.js`, one instance per plugin `apply()`.
	const inFlight = createInFlightGuard();

	ctx.effect(() => connectionOf(ctx).fetch.register({
		path: VIEW_ROUTE_PATH,
		methods: ['GET'],
		fetch: async (request) => {
			const token = new URL(request.url).searchParams.get('token');
			if (token === null || token === '') return new Response('not found', { status: 404 });
			const entry = viewTokens.lookup(token);
			if (entry === null) return new Response('not found', { status: 404 });
			let stored;
			try {
				stored = await ctx.attachments.readImage(entry.ref, request.signal);
			} catch {
				// An expired, revoked, or unreadable reference is indistinguishable
				// from an unknown token: never leak which case it was.
				return new Response('not found', { status: 404 });
			}
			return new Response(stored.data, {
				headers: {
					'content-type': entry.ref.mediaType,
					'cache-control': 'no-store',
				},
			});
		},
	}), 'image-question: read-only view route');

	// Every outstanding capability AND every in-flight registration dies with this
	// plugin fiber, so a reload cannot leave an agent permanently busy.
	ctx.effect(() => () => {
		viewTokens.clear();
		inFlight.clear();
	}, 'image-question: view token + in-flight tables');

	ctx.tools.register({
		name: TOOL_NAME,
		description: 'Ask the user a question about one or more images. Each question names one local image file, which Host reads and attaches so the user can view it in the Web UI, zoom and pan, and draw boxes; the answer comes back as annotations in source-image pixel coordinates, independent of zoom, pan, window size, and device pixel ratio. Every question in one request must carry exactly one image, and the whole batch is answered in one submission.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['questions'],
			properties: {
				questions: {
					type: 'array',
					description: 'Questions to ask, each about exactly one image.',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['id', 'question', 'source_image'],
						properties: {
							id: {
								type: 'string',
								description: 'Stable id for this question; echoed in the answer.',
							},
							question: {
								type: 'string',
								description: 'The specific question to ask the user.',
							},
							header: {
								type: 'string',
								description: 'Optional short heading, such as "NG 标注".',
							},
							source_image: {
								type: 'string',
								description: 'Absolute path to the image file to annotate (.png/.jpg/.jpeg/.webp/.gif). The image is read and admitted as a durable attachment; the path itself never crosses the wire.',
							},
							detail: {
								type: 'string',
								description: 'Optional supporting text shown with the question.',
							},
							sentinel: {
								type: 'string',
								description: 'Optional opaque round-trip token. It is delivered to the browser unchanged and echoed back in the answer, which lets a caller correlate one probe end to end.',
							},
						},
					},
				},
				timeout_ms: {
					type: 'number',
					description: 'Optional deadline in milliseconds for the human answer. Defaults to 600000; on expiry the tool returns a timeout error instead of hanging the agent loop.',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					// Neither this level nor the root declares `required`, and neither
					// may. A top-level `required` ARRAY is hard-enforced by the output
					// validator, so it would reject every `{ error }` failure branch and
					// erase its error code; `required` on this array node is rejected
					// outright by `assertSupportedJsonSchema`, whose keyword/type
					// whitelist admits the keyword only on `type: 'object'` nodes.
					// Both answer shapes stay legal purely as declared properties.
					//
					// Note: the built-in ask_user_question writes `required: true` on
					// its own array node, but built-ins never pass through this
					// assertion — do not copy built-in schema shapes into a plugin.
					answers: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: { type: 'string' },
								selected: { type: 'array', items: { type: 'string' } },
								mode: { type: 'string', description: '"annotated" | "generic-fallback"' },
								verdict: { type: 'string', enum: ['ng', 'ok', 'unsure'] },
								note: { type: 'string' },
								image: { type: 'object', additionalProperties: true },
								source_path: { type: 'string', description: 'Host-side source path, echoed back for the model and never sent over the wire.' },
								annotations: { type: 'array', items: { type: 'object' } },
								raw_custom: { type: 'string' },
							},
						},
					},
					error: { type: 'object', additionalProperties: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: JSON.stringify(value),
			}],
		},
		async execute(args, exec) {
			const agent = exec.agent;
			// `== null` covers both an absent agent and an explicit null.
			if (agent == null) {
				return {
					error: {
						name: 'NoLiveAgent',
						code: 'CALLER_NOT_LIVE',
						message: 'ask_user_question_image requires the exact live calling agent; this call has none, so no UI could ever answer it.',
					},
				};
			}

			const requested = Array.isArray(args?.questions) ? args.questions : [];
			if (requested.length === 0) {
				return {
					error: {
						name: 'EmptyQuestions',
						code: 'EMPTY_QUESTIONS',
						message: 'ask_user_question_image requires at least one question.',
					},
				};
			}

			// B11: claim this agent BEFORE the first readFile / saveImage, so a
			// refused call has no side effect at all — no attachment is admitted, no
			// view token is minted, and no card is ever put in front of the user.
			// Two different agents never collide here: their identity keys are
			// disjoint, so a parent and its subagent can each run their own question.
			const claimed = inFlight.claim(agent);
			if (claimed === null) {
				return {
					error: {
						name: 'ImageAnnotationBusy',
						code: BUSY_CODE,
						message: 'ask_user_question_image is already waiting for an answer from this agent. Put every image into ONE request instead of asking twice concurrently: ask once with one question per image, and the whole batch comes back in a single submission.',
					},
				};
			}

			const timeoutMs = Number.isFinite(args?.timeout_ms) && args.timeout_ms > 0
				? args.timeout_ms
				: DEFAULT_TIMEOUT_MS;
			const signal = composeSignal(exec.signal, timeoutMs);

			// Capability tokens minted by this call; revoked on every exit path.
			const issuedTokens = [];
			const sessionId = agent.session === undefined ? undefined : agent.session.id;

			try {
				// Read and admit every image before asking. Both the wire projection
				// and the browser selector require a complete image payload, so a
				// partial batch must fail here rather than render a half-usable card.
				const prepared = [];
				for (const question of requested) {
					const id = String(question.id);
					const sourceImage = String(question.source_image);
					const ref = await admitImage(ctx, sourceImage);
					// Minted before `ask()` so the card can fetch the image the moment
					// it mounts, and revoked as soon as `ask()` settles.
					const viewToken = viewTokens.issue(ref, sessionId, timeoutMs);
					issuedTokens.push(viewToken);
					prepared.push({ id, question, sourceImage, dimensions: dimensionsOf(ref), ref, viewToken });
				}

				const preparedById = new Map(prepared.map((item) => [item.id, item]));
				const questions = prepared.map((item) => ({
					id: item.id,
					question: String(item.question.question),
					...(typeof item.question.header === 'string' ? { header: item.question.header } : {}),
					...(typeof item.question.detail === 'string' ? { detail: item.question.detail } : {}),
					// The private protocol carrier. `ask()` only validates `intent`, so an
					// extra own enumerable key survives validation, the scoped waterfall
					// spread, and the Remote wire's lossless JSON copy.
					//
					// Every value here must be lossless JSON: the wire projection rejects
					// the whole request on a single non-JSON own value, so optional keys
					// are spread in rather than set to `undefined`.
					imageAnnotation: {
						schema: REQUEST_SCHEMA,
						image: {
							attachment: losslessRef(item.ref),
							// The read-only view capability for this one image. `attachment`
							// stays verbatim so the selector's attachmentId check is unchanged.
							viewToken: item.viewToken,
							sourceWidth: item.dimensions.sourceWidth,
							sourceHeight: item.dimensions.sourceHeight,
							storedWidth: item.dimensions.storedWidth,
							storedHeight: item.dimensions.storedHeight,
						},
						coordinateSpace: {
							kind: COORDINATE_SPACE,
							origin: 'top-left',
							xAxis: 'right',
							yAxis: 'down',
							width: item.dimensions.sourceWidth,
							height: item.dimensions.sourceHeight,
						},
						allowedTools: ['rect', 'brush'],
						noteMaxLength: NOTE_MAX_LENGTH,
						palette: DEFAULT_PALETTE.slice(),
						...(typeof item.question.sentinel === 'string' ? { sentinel: item.question.sentinel } : {}),
					},
				}));

				const answered = await ctx.userQuestions.ask({
					questions,
					agent,
					signal,
				});
				return {
					answers: (answered?.answers ?? []).map((answer) => {
						const custom = typeof answer.custom === 'string' ? answer.custom : undefined;
						let parsed;
						if (custom !== undefined) {
							try {
								parsed = JSON.parse(custom);
							} catch {
								parsed = undefined;
							}
						}
						const item = preparedById.get(String(answer.id));
						return {
							id: String(answer.id),
							selected: [...(answer.selected ?? [])],
							// A missing or unparseable `custom` still answers the question:
							// report the generic fallback instead of failing the tool.
							mode: parsed === undefined ? 'generic-fallback' : 'annotated',
							...(parsed?.verdict === undefined ? {} : { verdict: String(parsed.verdict) }),
							...(parsed?.note === undefined ? {} : { note: String(parsed.note) }),
							...(Array.isArray(parsed?.annotations) ? { annotations: parsed.annotations } : {}),
							...(parsed?.image === undefined ? {} : { image: parsed.image }),
							...(item === undefined ? {} : { source_path: item.sourceImage }),
							...(custom === undefined ? {} : { raw_custom: custom }),
						};
					}),
				};
			} catch (error) {
				// Admission failure and ask failure share one branch: both were reported
				// to the model as data before, and both still are.
				return { error: failureOf(error) };
			} finally {
				// answer / cancel / timeout / abort / ask failure / admission failure all
				// land here: the claim is released and every token is revoked.
				inFlight.release(claimed);
				viewTokens.revoke(issuedTokens);
			}
		},
	});
}
