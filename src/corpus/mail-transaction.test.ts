import { verifyNegativeControls } from './negative-control.ts';
import { CASES, MUTANTS } from './mail-transaction.ts';

verifyNegativeControls('mail-transaction', CASES, MUTANTS);
