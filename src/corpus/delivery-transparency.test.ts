import { CASES, MUTANTS } from './delivery-transparency.ts';
import { verifySinkControls } from './negative-control.ts';

// Sink-based negative controls: the mutant relays to a sink, and each case reads
// back the delivered message. Clean relay -> not a finding; the defect corrupts
// the delivered bytes and the case catches it.
verifySinkControls('delivery-transparency', CASES, MUTANTS);
