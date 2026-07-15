import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './termination.ts';
verifyNegativeControls('termination', CASES, MUTANTS);
