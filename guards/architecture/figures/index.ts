/** Every figure, in the order the tour runs them. */
import { CASCADE } from "./CascadeFigure.tsx";
import { FRAME_LOOP } from "./FrameLoopFigure.tsx";
import { LIST_ARENA } from "./ListArenaFigure.tsx";
import { MEMORY } from "./MemoryFigure.tsx";
import { PIPELINE } from "./PipelineFigure.tsx";
import { VARIANTS } from "./VariantsFigure.tsx";
import type { FigureSpec } from "./Figure.tsx";

export const FIGURES: FigureSpec[] = [PIPELINE, CASCADE, MEMORY, FRAME_LOOP, VARIANTS, LIST_ARENA];
