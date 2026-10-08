// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Legislative lifecycle stages of a tracked bill, as the engine stores them in
 * tracked_bills.current_stage (engine/src/scout/lifecycle.ts). The dashboard's
 * Bill Tracker filters, labels and timelines must use these ids: it used its
 * own names ('committee', 'passed_one_chamber', 'enacted', 'dead'), so most
 * stage filters matched nothing and the Enacted count was always 0.
 */
export const BILL_STAGES = [
  { id: 'rumor', label: 'Rumor / Discussion', phase: 'pre_legislative' },
  { id: 'executive_order', label: 'Executive Order', phase: 'pre_legislative' },
  { id: 'draft_circulated', label: 'Draft Circulated', phase: 'drafting' },
  { id: 'introduced', label: 'Introduced / Filed', phase: 'drafting' },
  { id: 'committee_referred', label: 'Referred to Committee', phase: 'committee' },
  { id: 'committee_hearing', label: 'Committee Hearing', phase: 'committee' },
  { id: 'committee_markup', label: 'Committee Markup', phase: 'committee' },
  { id: 'committee_passed', label: 'Passed Committee', phase: 'committee' },
  { id: 'floor_scheduled', label: 'Floor Vote Scheduled', phase: 'floor' },
  { id: 'floor_debate', label: 'Floor Debate', phase: 'floor' },
  { id: 'floor_vote', label: 'Floor Vote', phase: 'floor' },
  { id: 'passed_origin', label: 'Passed Origin Chamber', phase: 'floor' },
  { id: 'second_committee', label: 'Second Chamber Committee', phase: 'second_chamber' },
  { id: 'second_floor', label: 'Second Chamber Floor', phase: 'second_chamber' },
  { id: 'passed_second', label: 'Passed Second Chamber', phase: 'second_chamber' },
  { id: 'conference', label: 'Conference Committee', phase: 'second_chamber' },
  { id: 'sent_to_executive', label: 'Sent to Executive', phase: 'executive' },
  { id: 'executive_review', label: 'Executive Review', phase: 'executive' },
  { id: 'signed', label: 'Signed into Law', phase: 'executive' },
  { id: 'vetoed', label: 'Vetoed', phase: 'executive' },
  { id: 'veto_override', label: 'Veto Override', phase: 'executive' },
  { id: 'awaiting_effective', label: 'Awaiting Effective Date', phase: 'implementation' },
  { id: 'in_force', label: 'In Force', phase: 'implementation' },
  { id: 'repealed', label: 'Repealed', phase: 'terminal' },
  { id: 'died', label: 'Died / Failed', phase: 'terminal' },
  { id: 'stalled', label: 'Stalled', phase: 'terminal' },
] as const;

export type BillStageId = (typeof BILL_STAGES)[number]['id'];

/** Stages at which a bill has been enacted (engine/src/scout/outcome-recorder.ts). */
export const ENACTED_BILL_STAGES: readonly string[] = ['signed', 'veto_override', 'awaiting_effective', 'in_force', 'repealed'];

/** Stages at which a bill has failed or stopped moving. */
export const ENDED_BILL_STAGES: readonly string[] = ['died', 'stalled'];

export function billStageLabel(stage: string): string {
  return BILL_STAGES.find((s) => s.id === stage)?.label ?? stage.replace(/_/g, ' ');
}
