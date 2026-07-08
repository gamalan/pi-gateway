/**
 * pi-gateway-ask-user-rpc — RPC-mode bridge for ask_user_question
 *
 * The @juicesharp/rpiv-ask-user-question extension uses ctx.ui.custom() for its
 * rich TUI, which returns undefined in RPC mode (gateway), causing every
 * question to appear as "User declined to answer questions".
 *
 * This extension intercepts ask_user_question tool calls BEFORE they execute
 * via pi's tool_call event. In RPC mode it blocks the original tool and
 * re-implements the questionnaire using ctx.ui.select() / ctx.ui.confirm(),
 * which emit extension_ui_request events the gateway already handles
 * (Telegram inline keyboards, etc.). In TUI mode it does nothing — the
 * original extension handles it natively.
 *
 * Shipped as part of pi-gateway and loaded via pi --extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Answer envelope format (matching rpiv-ask-user-question) ────────────────

const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

interface QuestionOption {
	label: string;
	description: string;
	preview?: string;
}

interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

interface AskUserParams {
	questions: Question[];
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept ask_user_question in RPC mode
		if (event.toolName !== "ask_user_question") return;
		if (ctx.mode !== "rpc") return;

		// Block the original tool — it would call custom() which returns undefined
		const params = event.input as unknown as AskUserParams;
		if (!params?.questions?.length) {
			return { block: true, reason: "No questions to ask" };
		}

		// Process each question using select / confirm
		const segments: string[] = [];

		for (let i = 0; i < params.questions.length; i++) {
			const q = params.questions[i];
			const optionLabels = q.options.map((o) => o.label);

			if (q.multiSelect) {
				// Multi-select: confirm each option individually
				const selected: string[] = [];
				for (let j = 0; j < q.options.length; j++) {
					const opt = q.options[j];
					const confirmed = await ctx.ui.confirm(
						`${q.question}`,
						`Include "${opt.label}"?\n${opt.description}`,
					);
					if (confirmed) selected.push(opt.label);
				}
				if (selected.length > 0) {
					segments.push(`"${q.question}"="${selected.join(", ")}"`);
				}
			} else {
				// Single-select
				const value = await ctx.ui.select(q.question, optionLabels);
				if (value) {
					segments.push(`"${q.question}"="${value}"`);
				}
			}
		}

		// Inject the answers back — format matches what the model expects from
		// the original extension so it interprets them correctly.
		if (segments.length > 0) {
			pi.sendUserMessage(
				`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`,
				{ deliverAs: "steer" },
			);
		} else {
			pi.sendUserMessage("User declined to answer questions", {
				deliverAs: "steer",
			});
		}

		return { block: true, reason: "Handled by gateway RPC bridge" };
	});
}
