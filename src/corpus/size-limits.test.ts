import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './size-limits.ts';

verifyNegativeControls('size-limits', CASES, MUTANTS);
