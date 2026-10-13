import { jsx as e, jsxs as t } from "react/jsx-runtime";
import { useState as n } from "react";
//#region src/ui/Button.tsx
var r = "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-60", i = {
	primary: "rounded-lg border border-accent bg-accent text-white transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:border-line disabled:bg-line disabled:text-ink-muted",
	secondary: "rounded-md border border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
	pill: "rounded-full border border-line bg-surface text-ink-muted hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted"
}, a = {
	sm: "px-2.5 py-1 text-[11px]",
	md: "px-4 py-2 text-[12.5px] font-bold"
};
function o({ variant: t = "secondary", size: n = "sm", className: o = "", type: s, ...c }) {
	return /* @__PURE__ */ e("button", {
		type: s ?? "button",
		className: `${r} ${i[t]} ${a[n]} ${o}`,
		...c
	});
}
//#endregion
//#region src/ui/Pill.tsx
var s = {
	neutral: "bg-surface-muted text-ink-muted",
	accent: "bg-accent-soft text-accent",
	evidence: "bg-ev-soft text-ev",
	success: "bg-green-soft text-green",
	stale: "bg-stale-soft text-stale-ink",
	danger: "bg-danger/10 text-danger"
}, c = {
	neutral: "border border-line-strong",
	accent: "border border-accent",
	evidence: "border border-ev",
	success: "border border-green",
	stale: "border border-stale",
	danger: "border border-danger/40"
};
function l({ tone: t = "neutral", outline: n = !1, className: r = "", ...i }) {
	return /* @__PURE__ */ e("span", {
		className: `inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-none ${s[t]} ${n ? c[t] : ""} ${r}`,
		...i
	});
}
//#endregion
//#region src/ui/SegmentedControl.tsx
function u({ options: t, value: n, onChange: r, className: i = "", ...a }) {
	return /* @__PURE__ */ e("div", {
		className: `flex shrink-0 overflow-hidden rounded-md border border-line ${i}`,
		role: "group",
		"aria-label": a["aria-label"],
		children: t.map((t) => {
			let i = t.value === n;
			return /* @__PURE__ */ e("button", {
				className: `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${i ? "bg-ink text-canvas" : "bg-surface text-ink-muted hover:text-ink"}`,
				type: "button",
				"aria-pressed": i,
				title: t.title,
				onClick: () => r(t.value),
				children: t.label
			}, t.value);
		})
	});
}
//#endregion
//#region src/ui/EmptyState.tsx
function d({ icon: n, title: r, description: i, tone: a = "neutral", children: o, className: s = "" }) {
	return /* @__PURE__ */ t("div", {
		className: `rounded-xl border border-dashed ${a === "danger" ? "border-danger/40" : "border-line"} px-4 py-7 text-center ${s}`,
		children: [
			n && /* @__PURE__ */ e("p", {
				"aria-hidden": "true",
				className: "text-lg leading-none text-ink-muted",
				children: n
			}),
			/* @__PURE__ */ e("h2", {
				className: `${n ? "mt-2 " : ""}text-[13px] font-semibold ${a === "danger" ? "text-danger" : "text-ink"}`,
				children: r
			}),
			i && /* @__PURE__ */ e("p", {
				className: "mt-1 text-xs leading-relaxed text-ink-muted",
				children: i
			}),
			o && /* @__PURE__ */ e("div", {
				className: "mt-3 flex items-center justify-center gap-2",
				children: o
			})
		]
	});
}
//#endregion
//#region src/ui/Spinner.tsx
function f({ label: n, hint: r, className: i = "" }) {
	let a = /* @__PURE__ */ e("span", {
		"aria-hidden": "true",
		className: "animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent"
	});
	return !n && !r ? a : /* @__PURE__ */ t("div", {
		className: `flex flex-col items-center gap-3 text-center ${i}`,
		"aria-live": "polite",
		children: [
			a,
			n && /* @__PURE__ */ e("p", {
				className: "text-[13px] font-semibold text-ink",
				children: n
			}),
			r && /* @__PURE__ */ e("p", {
				className: "max-w-[34ch] text-xs leading-snug text-ink-muted",
				children: r
			})
		]
	});
}
//#endregion
//#region src/ui/Overline.tsx
function p({ as: t = "span", children: n, className: r = "" }) {
	return /* @__PURE__ */ e(t, {
		className: `text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted ${r}`,
		children: n
	});
}
//#endregion
//#region src/ui/Panel.tsx
function m({ header: n, footer: r, children: i, bodyClassName: a = "scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3", className: o = "" }) {
	return /* @__PURE__ */ t("div", {
		className: `flex h-full min-h-0 flex-col ${o}`,
		children: [
			n && /* @__PURE__ */ e("header", {
				className: "flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5",
				children: n
			}),
			/* @__PURE__ */ e("div", {
				className: a,
				children: i
			}),
			r && /* @__PURE__ */ e("footer", {
				className: "flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2",
				children: r
			})
		]
	});
}
//#endregion
//#region src/ui/ResultValue.tsx
function h(e) {
	return typeof e == "object" && !!e && !Array.isArray(e);
}
function g() {
	return /* @__PURE__ */ e("span", {
		className: "rounded-full border border-line-strong bg-surface-muted px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint",
		children: "Missing"
	});
}
function _({ expanded: t }) {
	return /* @__PURE__ */ e("svg", {
		width: "8",
		height: "8",
		viewBox: "0 0 8 8",
		fill: "currentColor",
		style: {
			transform: t ? "rotate(90deg)" : "none",
			transition: "transform 120ms"
		},
		children: /* @__PURE__ */ e("polygon", { points: "0,0 8,4 0,8" })
	});
}
function v() {
	return /* @__PURE__ */ e("svg", {
		width: "13",
		height: "13",
		viewBox: "0 0 20 20",
		fill: "currentColor",
		children: /* @__PURE__ */ e("path", { d: "M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" })
	});
}
function y(e) {
	for (let t of Object.values(e)) if (typeof t == "string" && t.trim()) return t.trim();
	return null;
}
function b({ name: r, value: i, path: a, onChange: o, expandText: s, evidenceAnchorId: c, onSelectEvidence: l }) {
	let u = i == null || i === "", d = u ? "" : String(i), [f, p] = n(!1), [m, h] = n(""), [_, y] = n(!1), b = !s && d.length > 80;
	function x() {
		h(d), p(!0);
	}
	function S() {
		o?.(a, m), p(!1);
	}
	function C() {
		p(!1);
	}
	return f ? /* @__PURE__ */ t("div", {
		className: "my-0.5 flex items-center gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2",
		children: [
			/* @__PURE__ */ e("span", { className: "w-2 shrink-0" }),
			/* @__PURE__ */ e("span", {
				className: "shrink-0 font-mono text-[13.5px] font-medium text-ink",
				children: r
			}),
			/* @__PURE__ */ e("input", {
				className: "min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-ink outline-none focus-visible:border-accent",
				value: m,
				autoFocus: !0,
				onChange: (e) => h(e.target.value),
				onKeyDown: (e) => {
					e.key === "Enter" && S(), e.key === "Escape" && C();
				}
			}),
			/* @__PURE__ */ e("button", {
				className: "shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108",
				type: "button",
				onClick: S,
				children: "Save"
			}),
			/* @__PURE__ */ e("button", {
				className: "shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent",
				type: "button",
				onClick: C,
				children: "✗"
			})
		]
	}) : s && !u ? /* @__PURE__ */ t("div", {
		className: "-mx-2 group rounded-md px-2 pb-2 pt-1.5 transition-colors hover:bg-accent-ghost/30",
		children: [/* @__PURE__ */ t("div", {
			className: "flex items-center gap-2",
			children: [
				/* @__PURE__ */ e("span", { className: "w-2 shrink-0" }),
				/* @__PURE__ */ e("span", {
					className: "shrink-0 font-mono text-[13.5px] font-medium text-ink",
					children: r
				}),
				o && /* @__PURE__ */ e("button", {
					className: "shrink-0 cursor-pointer px-0.5 text-ink-faint opacity-0 outline-none transition-all group-hover:opacity-100 hover:text-accent",
					type: "button",
					title: `Edit ${r}`,
					onClick: x,
					children: /* @__PURE__ */ e(v, {})
				}),
				c && l && /* @__PURE__ */ e("button", {
					className: "shrink-0 cursor-pointer rounded-full border border-accent/40 bg-accent-ghost px-2 py-0.5 text-[10.5px] font-bold text-accent outline-none hover:border-accent",
					type: "button",
					"aria-label": `View Evidence for ${r}`,
					onClick: () => l(c),
					children: "Evidence"
				})
			]
		}), /* @__PURE__ */ e("div", {
			className: "pl-4 pt-0.5 text-[13px] leading-relaxed text-ink-muted wrap-anywhere whitespace-pre-wrap",
			children: d
		})]
	}) : /* @__PURE__ */ t("div", {
		className: "-mx-2 group rounded-md px-2 transition-colors hover:bg-accent-ghost/30",
		children: [/* @__PURE__ */ t("div", {
			className: "flex items-center gap-2 py-1.5",
			children: [
				/* @__PURE__ */ e("span", { className: "w-2 shrink-0" }),
				/* @__PURE__ */ e("span", {
					className: "shrink-0 truncate font-mono text-[13.5px] font-medium text-ink",
					children: r
				}),
				u ? /* @__PURE__ */ e(g, {}) : /* @__PURE__ */ e("span", {
					className: "min-w-0 flex-1 truncate text-[13px] text-ink-muted",
					children: d
				}),
				b && !u && /* @__PURE__ */ e("button", {
					className: "shrink-0 cursor-pointer text-[11px] font-bold text-accent outline-none hover:underline",
					type: "button",
					onClick: () => y((e) => !e),
					children: _ ? "Less" : "More"
				}),
				c && l && /* @__PURE__ */ e("button", {
					className: "shrink-0 cursor-pointer rounded-full border border-accent/40 bg-accent-ghost px-2 py-0.5 text-[10.5px] font-bold text-accent outline-none hover:border-accent",
					type: "button",
					"aria-label": `View Evidence for ${r}`,
					onClick: () => l(c),
					children: "Evidence"
				}),
				o && /* @__PURE__ */ e("button", {
					className: "shrink-0 cursor-pointer px-0.5 text-ink-faint opacity-0 outline-none transition-all group-hover:opacity-100 hover:text-accent",
					type: "button",
					title: `Edit ${r}`,
					onClick: x,
					children: /* @__PURE__ */ e(v, {})
				})
			]
		}), _ && !u && /* @__PURE__ */ e("div", {
			className: "pb-2 pl-6 text-[13px] leading-relaxed text-ink wrap-anywhere whitespace-pre-wrap",
			children: d
		})]
	});
}
function x({ name: r, value: i, path: a, onChange: o, depth: s, defaultExpanded: c = !0, onNavigateTo: l, expandText: u, getEvidenceAnchorId: d, onSelectEvidence: f }) {
	let [p, m] = n(c), h = Object.entries(i), v = y(i);
	return /* @__PURE__ */ t("div", { children: [/* @__PURE__ */ t("div", {
		className: "-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent-ghost/30",
		onClick: () => l ? l(a) : m((e) => !e),
		children: [
			/* @__PURE__ */ e("span", {
				className: "shrink-0 text-ink-faint",
				children: /* @__PURE__ */ e(_, { expanded: p })
			}),
			/* @__PURE__ */ e("span", {
				className: "shrink-0 truncate font-mono text-[13.5px] font-medium text-ink",
				children: r
			}),
			p ? /* @__PURE__ */ t("span", {
				className: "shrink-0 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white",
				children: [
					h.length,
					" field",
					h.length === 1 ? "" : "s"
				]
			}) : v ? /* @__PURE__ */ e("span", {
				className: "min-w-0 flex-1 truncate text-[13px] text-ink-muted",
				children: v
			}) : /* @__PURE__ */ e(g, {})
		]
	}), p && /* @__PURE__ */ e("div", {
		className: "ml-3.5 mt-0.5 border-l border-line pl-3",
		children: h.length === 0 ? /* @__PURE__ */ e("p", {
			className: "py-1.5 text-[13px] text-ink-muted",
			children: "No fields returned."
		}) : h.map(([t, n]) => /* @__PURE__ */ e(C, {
			name: t,
			value: n,
			path: [...a, t],
			onChange: o,
			onNavigateTo: l,
			defaultExpanded: !l && void 0,
			expandText: u,
			getEvidenceAnchorId: d,
			onSelectEvidence: f,
			depth: s + 1
		}, t))
	})] });
}
function S({ name: r, value: i, path: a, onChange: o, depth: s, onNavigateTo: c, expandText: l, getEvidenceAnchorId: u, onSelectEvidence: d }) {
	let [f, p] = n(!0);
	return /* @__PURE__ */ t("div", { children: [/* @__PURE__ */ t("div", {
		className: "-mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent-ghost/30",
		onClick: () => c ? c(a) : p((e) => !e),
		children: [
			/* @__PURE__ */ e("span", {
				className: "shrink-0 text-ink-faint",
				children: /* @__PURE__ */ e(_, { expanded: f })
			}),
			/* @__PURE__ */ e("span", {
				className: "min-w-0 truncate font-mono text-[13.5px] font-medium text-ink",
				children: r
			}),
			/* @__PURE__ */ t("span", {
				className: "shrink-0 whitespace-nowrap rounded-full bg-surface-muted px-2.5 py-0.5 font-sans text-[10.5px] font-semibold text-ink-muted",
				children: [
					i.length,
					" item",
					i.length === 1 ? "" : "s"
				]
			})
		]
	}), f && /* @__PURE__ */ e("div", {
		className: "ml-3.5 mt-0.5 border-l border-line pl-3",
		children: i.length === 0 ? /* @__PURE__ */ e("div", {
			className: "py-1",
			children: /* @__PURE__ */ e(g, {})
		}) : i.map((t, n) => /* @__PURE__ */ e(C, {
			name: `Item ${n + 1}`,
			value: t,
			path: [...a, String(n)],
			onChange: o,
			onNavigateTo: c,
			depth: s + 1,
			defaultExpanded: !1,
			expandText: l,
			getEvidenceAnchorId: u,
			onSelectEvidence: d
		}, `${r}-${n}`))
	})] });
}
function C({ name: t, value: n, path: r = [], onChange: i, depth: a = 0, defaultExpanded: o, onNavigateTo: s, expandText: c, getEvidenceAnchorId: l, onSelectEvidence: u }) {
	return Array.isArray(n) ? /* @__PURE__ */ e(S, {
		name: t,
		value: n,
		path: r,
		onChange: i,
		depth: a,
		onNavigateTo: s,
		expandText: c,
		getEvidenceAnchorId: l,
		onSelectEvidence: u
	}) : h(n) ? /* @__PURE__ */ e(x, {
		name: t,
		value: n,
		path: r,
		onChange: i,
		depth: a,
		defaultExpanded: o,
		onNavigateTo: s,
		expandText: c,
		getEvidenceAnchorId: l,
		onSelectEvidence: u
	}) : /* @__PURE__ */ e(b, {
		name: t,
		value: n,
		path: r,
		onChange: i,
		expandText: c,
		evidenceAnchorId: l?.(r),
		onSelectEvidence: u
	});
}
//#endregion
export { o as Button, d as EmptyState, p as Overline, m as Panel, l as Pill, C as ResultValue, u as SegmentedControl, f as Spinner };
