/**
 * The window's chrome. An ordinary component in the window folder — `pages/` holds
 * routes and nothing else.
 *
 * These are real links. `href` is checked against the route table at build time —
 * a typo\'d path fails the compile — and the click handler is synthesized by the
 * compiler as a write to the window's route signal: the host looks the path up in
 * the compiled route table and writes `hidden` over the routes that left the
 * chain. One byte per route root, no allocation, one relayout. The fifteen
 * exported go* handlers this file used to import are gone with nothing in their
 * place, which is the point.
 *
 * The active entry is `router.matches(path)` in a conditional class. Nothing
 * compares strings at run time — the comparison is compiled into a cell and then
 * into style-table writes, so highlighting costs a few integers when the route
 * changes and nothing per frame.
 *
 * `no-underline` because the UA sheet underlines an anchor the way a browser
 * would, and these are tabs. `hover:` compiles to an escaped selector
 * (`.hover\:bg-zinc-700:hover`) and a predicate bit, so hovering is resolved by
 * the engine with nothing sent back here.
 */
import { cn, useRouter } from 'dziry';

const LINK = 'link rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 no-underline hover:bg-zinc-700';

export function Nav() {
    const router = useRouter();

    return (
        <div className="flex flex-row flex-wrap space-y-4 items-center justify-between rounded-xl bg-zinc-900 px-5 py-4">
            <div className="flex flex-col gap-1">
                <div className="heading text-lg font-semibold text-zinc-50">Tailwind, compiled</div>
                <div className="muted text-xs text-zinc-400">
                    real utility CSS · resolved at build time · no CSS at run time
                </div>
            </div>
            <div className="flex flex-row flex-wrap gap-2">
                <a href="/" className={cn(LINK, { active: router.matches('/') })}>
                    Overview
                </a>
                <a href="layout" className={cn(LINK, { active: router.matches('layout') })}>
                    Layout
                </a>
                <a href="spacing" className={cn(LINK, { active: router.matches('spacing') })}>
                    Spacing
                </a>
                <a href="typography" className={cn(LINK, { active: router.matches('typography') })}>
                    Type
                </a>
                <a href="colors" className={cn(LINK, { active: router.matches('colors') })}>
                    Color
                </a>
                <a href="borders" className={cn(LINK, { active: router.matches('borders') })}>
                    Borders
                </a>
                <a href="controls" className={cn(LINK, { active: router.matches('controls') })}>
                    Controls
                </a>
                <a href="transforms" className={cn(LINK, { active: router.matches('transforms') })}>
                    Transform
                </a>
                <a href="animations" className={cn(LINK, { active: router.matches('animations') })}>
                    Motion
                </a>
                <a href="features" className={cn(LINK, { active: router.matches('features') })}>
                    Features
                </a>
                <a href="reactivity" className={cn(LINK, { active: router.matches('reactivity') })}>
                    Reactivity
                </a>
                <a href="forms" className={cn(LINK, { active: router.matches('forms') })}>
                    Forms
                </a>
                {/* Prefix-aware: stays lit on products/new and products/$id too. */}
                <a href="products/new" className={cn(LINK, { active: router.matches('products') })}>
                    Routing
                </a>
            </div>
        </div>
    );
}
