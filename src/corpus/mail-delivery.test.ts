import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './mail-delivery.ts';

verifyNegativeControls('mail-delivery', CASES, MUTANTS);
