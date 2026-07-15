import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './session-sequencing.ts';

verifyNegativeControls('session-sequencing', CASES, MUTANTS);
