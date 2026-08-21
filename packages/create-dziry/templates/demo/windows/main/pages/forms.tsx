/**
 * The route at `"forms"` — a whole form, and nothing but markup, CSS and a schema.
 *
 * There is no state module for the scalar fields here. Every named control gets a cell the
 * *compiler* declares in `ui.gen.ts`, seeded from its `value` attribute, and the only way to
 * read one is the payload `onSubmit` is handed. So the page below is the entire app: no
 * `useState`, no per-field signals, no form library.
 *
 * What each piece is doing:
 *
 * - **`field` on a wrapper names a group**, and the wrapper chain is the path. A wrapper
 *   holding one bare control *is* that field; a wrapper holding named controls makes them its
 *   properties. So `address` + `city`/`street` inside it produces a nested object, and no
 *   bracket syntax was parsed to get there. No browser nests anything —
 *   `name="user[email]"` is the literal key `"user[email]"` in `FormData`, measured in
 *   `probes/form-nested-names.html` — so this is dziry's, and a compiler can do it because it
 *   can see the structure.
 *
 * - **A wrapper holding a `map()` is an array field**, which is the one field whose value the
 *   compiler does not own. Its rows are an arena of interchangeable replicas, so there is
 *   nothing stable to declare a per-row cell against — but the array already has one entry
 *   per row and a key for each, so the array *is* the state. `bind:value={job.title}` writes
 *   back into it, and the payload's `experience` is that array.
 *
 * - **A row's own message and a row's own `:invalid`** are the two halves of error display that
 *   can be per row, and they get there differently. The message is a *string*, and every replica
 *   owns its text slots. The colour is a *style*, and replicas share a style row — so the border
 *   comes from a predicate the engine resolves per node against the controls table, which each
 *   replica does have its own row in. That is the whole reason `:invalid` is a protocol bit and
 *   not a class.
 *
 * - **`errorClassName` dresses what is around a field**, and it is a class. The wrapper wears it while
 *   any issue's path starts with the wrapper's own, so `address` lights up for an issue at
 *   `address.city` and `experience` lights up for one at `experience.0.title`. It compiles to
 *   style-table writes, which is why the input's border and the message's visibility both come
 *   from a class on the div and none of it is JavaScript.
 *
 * - **`<span error />`** is where the message goes. Its text becomes a run bound to a cell the
 *   compiler declared; whatever is written inside it is placeholder prose that never ships.
 *
 * - **`validateOn="change"`** checks as you type. Before the first submit a field may only show
 *   an error once its value has *moved* off the one it was compiled with, so the page does not
 *   greet you in red — and that gate costs no state, because the initial value is a constant.
 *
 * - **`alert()`** is the platform's own modal, `SDL_ShowSimpleMessageBox` behind an FFI call on
 *   the engine thread. Submitting a valid form opens it with the payload as JSON, which is the
 *   point of the page: the object in that box is what a handler receives.
 */
import { alert, computed, signal } from 'dziry';

const CARD = 'flex flex-col gap-3 rounded-xl bg-zinc-900 p-6';
const H = 'text-lg font-semibold text-zinc-50';
const SUB = 'muted text-xs text-zinc-400';
const LABEL = 'text-xs text-zinc-300';
const FIELD =
    'field w-64 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100 error:border-rose-500';
const NOTE = 'note text-xs font-semibold text-rose-400';
const WRAP = 'flex flex-col gap-1';
/**
 * A row's cell. Narrower than `FIELD`, because three of these share a line.
 *
 * `cell` rather than a `w-*` utility: `input[type="text"]` in the sheet is a type selector plus
 * an attribute one, which out-specifies a lone utility class — so a `w-28` here would lose to
 * the sheet's 260px and the row would overflow. The width is in `app.css` beside the rule it
 * has to beat.
 */
const CELL = 'cell rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-100';
const SMALL =
    'self-start rounded-lg bg-zinc-700 px-2 py-1 text-xs font-semibold text-zinc-100';

/**
 * One row of the repeating section.
 *
 * `id` is the list's `key`, and it is in the payload — an array field's value is the array as
 * authored, because deciding which properties are "really" fields would be the compiler
 * guessing at intent. A schema that minds can drop it.
 */
type Job = { id: number; title: string; start: string; end: string };

/**
 * The rows, which are the only state this form declares.
 *
 * This is the whole reason an array field works differently from every other field: the rest
 * get a cell the compiler declares, and a row cannot — a row's controls live in a list arena,
 * `capacity` interchangeable replicas of one template, so there is nothing stable to declare a
 * cell against. The array has one entry per row and a key for each, so the array is the state,
 * and adding a row is an ordinary `signal.set`.
 */
export const jobs = signal<Job[]>([
    { id: 1, title: 'line cook', start: '2019', end: '2021' },
    { id: 2, title: 'dishwasher', start: '2018', end: '2019' },
]);

/** Ids rather than indices, so removing a row cannot renumber the ones after it. */
let nextJobId = 3;

/**
 * Appends a row.
 *
 * There is no form API to call and nothing to tell the compiler. The list is already compiled
 * against this signal, so a new item is a new row — and the row's inputs are already bound to
 * that item's properties, because the binding is per *offset in the template* rather than per
 * node.
 */
export const addJob = () => {
    jobs.set((rows) => [
        ...rows,
        { id: nextJobId++, title: '', start: '', end: '' },
    ]);
};

/** Drops one row. A per-row handler is handed the item that was clicked. */
export const removeJob = (job: Job) => {
    jobs.set((rows) => rows.filter((row) => row.id !== job.id));
};

/**
 * Whether the terms box is ticked, as state the *app* owns.
 *
 * A second copy of something the artifact already has, and the duplication is the honest cost
 * of the current API rather than an oversight. Every named field gets a cell the compiler
 * declares, and that cell is deliberately unnameable from out here — the payload is how you
 * read it. So a field whose value has to drive something *else* on the page needs the app to
 * hold it too, and the checkbox's `onChange` is what keeps the two in step.
 *
 * `bind:checked` is what removes the copy: the author's signal would *be* the cell, the way
 * `bind:value` already is for text. It is not built.
 */
export const termsAccepted = signal(false);

/** The engine hands a checkbox's `onChange` a boolean, so this is the whole binding. */
export const onTermsChange = (on: boolean) => {
    termsAccepted.set(on === true);
};

/**
 * `disabled` takes a signal, so "enabled only once the terms are ticked" is one derived cell.
 *
 * Not a conditional class: `disabled` is a *control flag* Bun writes into the controls table,
 * and the engine both re-reads it for `:disabled` styling and refuses presses on it. So one
 * signal buys the greyed-out look and the refusal, and it also blocks Enter — a form whose
 * button is switched off is not submittable by any route.
 */
export const cannotSubmit = computed(() => !termsAccepted);

/** How many times the form has been submitted successfully — proof the handler ran. */
export const accepted = signal(0);

/** The last payload, kept on the page as well as shown in the box. */
export const lastPayload = signal('nothing yet');

/**
 * What a submitted payload looks like, spelled out because it is the point of the page.
 *
 * The shape comes from the markup: `field` wrappers are namespaces, a `type=number` field is a
 * number, a checkbox is a boolean, and a wrapper holding a `map()` is an array of whatever the
 * rows are. An author writing a Zod or Effect schema writes it against exactly this.
 */
type SignUp = {
    email: string;
    age: number | undefined;
    terms: boolean;
    plan: string | undefined;
    address: { city: string; street: string };
    /** The repeating section. One entry per live row, in the order they are shown. */
    experience: Job[];
};

/**
 * The rules, as a plain predicate.
 *
 * `validate` also takes any Standard Schema — Zod, Valibot, ArkType — or an Effect schema, and
 * this demo uses neither so that the page proves the wiring rather than a dependency. The
 * issue shape is the one every validator is reduced to: `{ path, message }[]`, where the path
 * is what decides which wrapper lights up.
 */
export const checkSignUp = (data: SignUp) => {
    // `(string | number)[]`, because a row's index is a segment — see `checkExperience`.
    const issues: { path: (string | number)[]; message: string }[] = [];

    if (!data.email.includes('@')) {
        issues.push({ path: ['email'], message: 'needs to look like an email' });
    }
    if (data.age === undefined) {
        issues.push({ path: ['age'], message: 'how old are you?' });
    } else if (data.age < 18) {
        issues.push({ path: ['age'], message: 'must be 18 or over' });
    }
    if (!data.terms) {
        issues.push({ path: ['terms'], message: 'the terms are not optional' });
    }
    if (data.plan === undefined) {
        issues.push({ path: ['plan'], message: 'pick a plan' });
    }
    // Three depths under one wrapper, so the three `error` markers each have something to say
    // and the split between them is visible: a leaf's complaint goes beside that leaf, and the
    // group-level one goes in the bare marker at the bottom.
    if (data.address.street.trim() === '') {
        issues.push({ path: ['address', 'street'], message: 'street is required' });
    }
    if (data.address.city.trim() === '') {
        issues.push({ path: ['address', 'city'], message: 'city is required' });
    }
    if (
        data.address.street.trim() !== '' &&
        data.address.street.trim() === data.address.city.trim()
    ) {
        issues.push({
            path: ['address'],
            message: 'street and city cannot be the same',
        });
    }
    issues.push(...checkExperience(data.experience));

    return issues.length === 0 ? null : issues;
};

/**
 * The rows' rules, and the one place a path is not made only of names.
 *
 * A row's index is a path segment — `experience.0.title` — and that is what lights the wrapper
 * up: a wrapper owns an issue when its path is a *prefix* of the issue's, and `["experience"]`
 * is a prefix of that however deep it goes. Only one message can be shown for the group, which
 * is why each names its row.
 */
const checkExperience = (rows: readonly Job[]) => {
    const issues: { path: (string | number)[]; message: string }[] = [];

    if (rows.length === 0) {
        issues.push({ path: ['experience'], message: 'add at least one job' });
    }

    // No "row N:" prefix any more, because the message is shown *in* the row — the numbering
    // was standing in for a position the markup can now express.
    for (const [i, row] of rows.entries()) {
        if (row.title.trim() === '') {
            issues.push({
                path: ['experience', i, 'title'],
                message: 'what was the job?',
            });
        }
        if (row.start.trim() === '') {
            issues.push({
                path: ['experience', i, 'start'],
                message: 'needs a start year',
            });
        }
        // Deliberately not "end is required": an open-ended row is the current job, which a
        // form demanding both would have no way to express.
        if (row.end.trim() !== '' && row.end.trim() < row.start.trim()) {
            issues.push({
                path: ['experience', i, 'end'],
                message: 'ends before it starts',
            });
        }
    }

    return issues;
};

/**
 * The success path: the payload, in the platform's own dialog.
 *
 * `JSON.stringify` with two spaces, because the nesting is the thing worth seeing — a flat
 * dump would hide that `address` is an object rather than two keys with dots in them, and that
 * `experience` is an array of objects rather than a joined string.
 */
export const onSignUp = (data: SignUp) => {
    const json = JSON.stringify(data, null, 2);
    accepted.set(accepted + 1);
    lastPayload.set(json);
    alert(json, { title: 'onSubmit received' });
};

/**
 * The failure path.
 *
 * The wrappers have already lit up by the time this runs — that is the class, and it needs no
 * handler. This exists to show the same issues *as data*, and because a form with a `validate`
 * and no `onInvalid` simply does nothing on a bad payload, which is correct and silent.
 */
export const onSignUpRejected = (
    issues: { path: (string | number)[]; message: string }[],
) => {
    lastPayload.set(
        `${issues.length} problem(s): ${issues
            .map((i) => `${i.path.join('.')} — ${i.message}`)
            .join(' · ')}`,
    );
    alert(
        issues.map((i) => `• ${i.path.join('.')}: ${i.message}`).join('\n'),
        { title: 'That form is not ready', level: 'warning' },
    );
};

export default function Forms() {
    return (
        <div className="flex flex-col gap-5">
            <div className={CARD}>
                <div className={H}>a form, with no state module</div>
                <div className={SUB}>
                    nothing on this page declares a signal for a scalar field · `field` on a
                    wrapper names a group, the compiler declares the cell, and the payload is
                    the only way to read it back
                </div>
                <div className={SUB}>
                    submit it valid and the platform's own message box opens with the payload as
                    JSON — that box is `SDL_ShowSimpleMessageBox`, so it is a Win32 task dialog
                    here and an `NSAlert` on a Mac · submit it broken and the wrappers light up
                    from a class while the offending field wears `:invalid`, with no JavaScript
                    involved in either
                </div>
                <div className={SUB}>
                    the rows are why `:invalid` exists · replicas of one template share a style
                    row, so a class would redden every row at once — a predicate is resolved per
                    node against the controls table, so one row can be wrong on its own
                </div>
                <div className={SUB}>
                    `validateOn="change"` · it checks as you type, but a field stays quiet until
                    its value has *moved* off the one it was compiled with, which is why the page
                    does not open in red
                </div>

                <form
                    className="flex flex-col gap-4"
                    validateOn="change"
                    validate={checkSignUp}
                    onSubmit={onSignUp}
                    onInvalid={onSignUpRejected}
                >
                    <div field="email" errorClassName="group/error" className={WRAP}>
                        <span className={LABEL}>email</span>
                        <input type="text" placeholder="you@example.com" className={FIELD} />
                        <span error className={NOTE} />
                    </div>

                    <div field="age" errorClassName="group/error" className={WRAP}>
                        <span className={LABEL}>age — a number, not a string</span>
                        <input type="number" value="31" className={FIELD} />
                        <span error className={NOTE} />
                    </div>

                    {/* Two named controls under one wrapper, so they become its properties and
                        the payload gains an object.

                        Three `error` markers, and the names are what divide the group's
                        complaints up: `error="city"` shows the issue at `address.city`, and the
                        bare one keeps whatever is only the group's own — so nothing is said
                        twice. The name is relative to this wrapper, exactly as `name` is, which
                        is what makes the group movable. */}
                    <div field="address" errorClassName="group/error" className={WRAP}>
                        <span className={LABEL}>address — two named inputs, one group</span>
                        <div className="flex flex-row gap-2">
                            <div className="flex flex-col gap-1">
                                <input
                                    type="text"
                                    name="street"
                                    placeholder="street"
                                    className={FIELD}
                                />
                                <span error="street" className={NOTE} />
                            </div>
                            <div className="flex flex-col gap-1">
                                <input
                                    type="text"
                                    name="city"
                                    placeholder="city"
                                    className={FIELD}
                                />
                                <span error="city" className={NOTE} />
                            </div>
                        </div>
                        <span error className={NOTE} />
                    </div>

                    <div field="plan" errorClassName="group/error" className={WRAP}>
                        <span className={LABEL}>plan — a radio set is one value</span>
                        <div className="flex flex-row items-center gap-4">
                            <label className="flex flex-row items-center gap-2 text-xs text-zinc-300">
                                <input type="radio" name="plan" value="free" className="check" />
                                free
                            </label>
                            <label className="flex flex-row items-center gap-2 text-xs text-zinc-300">
                                <input type="radio" name="plan" value="pro" className="check" />
                                pro
                            </label>
                        </div>
                        <span error className={NOTE} />
                    </div>

                    {/* A repeating section. The wrapper's value is the array behind the map()
                        inside it, so the payload gains `experience: Job[]` — one entry per
                        live row, and no per-row cell was declared anywhere. Each input binds
                        to its own row's property, which is what makes typing write back into
                        `jobs` and what makes a reorder free. */}
                    <div field="experience" errorClassName="group/error" className={WRAP}>
                        <span className={LABEL}>
                            work experience — rows added at run time
                        </span>
                        <div className="flex flex-col gap-2">
                            {jobs.map(
                                (job) => (
                                    <div className="flex flex-row items-center gap-2">
                                        <input
                                            type="text"
                                            placeholder="title"
                                            className={CELL}
                                            bind:value={job.title}
                                        />
                                        <input
                                            type="text"
                                            placeholder="from"
                                            className={CELL}
                                            bind:value={job.start}
                                        />
                                        <input
                                            type="text"
                                            placeholder="to"
                                            className={CELL}
                                            bind:value={job.end}
                                        />
                                        <button
                                            type="button"
                                            className={SMALL}
                                            onClick={removeJob}
                                        >
                                            remove
                                        </button>
                                        {/* The row's own message. Every replica owns its
                                            text slots, so this string differs row by row —
                                            which is why the complaint lands beside the row
                                            that caused it rather than under the section. */}
                                        <span error className={NOTE} />
                                    </div>
                                ),
                                { key: (job: Job) => job.id },
                            )}
                        </div>
                        {/* `type="button"`, so it adds a row rather than submitting. A bare
                            <button> defaults to submit — measured — which is what makes the
                            "sign up" button below the one Enter reaches. */}
                        <button type="button" className={SMALL} onClick={addJob}>
                            add a row
                        </button>
                        <span error className={NOTE} />
                    </div>

                    {/* The checkbox keeps its compiler-declared cell, so `terms` is still in
                        the payload; the `onChange` is a *second* reader, for the button below.
                        Both see the same click — `applyFieldChange` writes the cell before any
                        handler runs, so the payload and the page cannot disagree. */}
                    <div field="terms" errorClassName="group/error" className={WRAP}>
                        <label className="flex flex-row items-center gap-2 text-xs text-zinc-300">
                            <input
                                type="checkbox"
                                className="check"
                                onChange={onTermsChange}
                            />
                            I accept the terms
                        </label>
                        <span error className={NOTE} />
                    </div>

                    {/* Switched off until the terms are ticked. `disabled` takes a signal, so
                        this is the derived cell above and nothing else: the engine greys the
                        button through `:disabled`, refuses presses on it, and Enter refuses
                        too — a form whose button is off has no route in. */}
                    <button
                        type="submit"
                        disabled={cannotSubmit}
                        className="self-start rounded-lg bg-sky-700 px-4 py-1.5 text-xs font-semibold text-zinc-50"
                    >
                        sign up
                    </button>
                </form>
            </div>

            <div className={CARD}>
                <div className={H}>what the handler got</div>
                <div className={SUB}>
                    the same text the message box showed · `address` is an object and
                    `experience` is an array, and no path was parsed to make them one — the
                    wrappers are the paths
                </div>
                <div className="text-xs font-semibold text-sky-300">{lastPayload}</div>
                <div className={SUB}>accepted submissions: {accepted}</div>
            </div>
        </div>
    );
}
