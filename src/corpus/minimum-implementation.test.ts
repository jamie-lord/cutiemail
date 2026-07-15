import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './minimum-implementation.ts';

verifyNegativeControls('minimum-implementation', CASES, MUTANTS);
