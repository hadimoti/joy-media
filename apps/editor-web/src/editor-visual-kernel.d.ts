import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
/** Synchronous initial-shell command kernel. Optional editor surfaces stay out of this module. */
export declare function applyVisualObjectProjectTransaction(project: JoyProjectV1, transaction: VisualObjectTransaction): JoyProjectV1;
export declare class VisualObjectProjectHistory {
    #private;
    constructor(initial: JoyProjectV1);
    get present(): JoyProjectV1;
    apply(transaction: VisualObjectTransaction): JoyProjectV1;
    replacePresent(next: JoyProjectV1): JoyProjectV1;
    undo(): {
        readonly project: JoyProjectV1;
        readonly transaction: VisualObjectTransaction;
    };
    redo(): {
        readonly project: JoyProjectV1;
        readonly transaction: VisualObjectTransaction;
    };
}
//# sourceMappingURL=editor-visual-kernel.d.ts.map