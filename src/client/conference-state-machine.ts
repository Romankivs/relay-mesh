// Conference state machine for managing lifecycle transitions
import { EventEmitter } from 'events';
import type { ParticipantMetrics } from '../shared/types';

export enum ConferenceState {
  IDLE = 'idle',
  JOINING = 'joining',
  CONNECTED = 'connected',
  LEAVING = 'leaving',
}

export interface StateTransitionEvent {
  from: ConferenceState;
  to: ConferenceState;
  timestamp: number;
}

export interface ConferenceStateMachine {
  // Get current state
  getCurrentState(): ConferenceState;

  // Transition to joining state
  startJoin(conferenceId: string, participantId: string): Promise<void>;

  // Transition to connected state
  completeJoin(): Promise<void>;

  // Transition to leaving state
  startLeave(): Promise<void>;

  // Transition back to idle state
  completeLeave(): Promise<void>;

  // Check if transition is valid
  canTransition(to: ConferenceState): boolean;

  // Subscribe to state changes
  onStateChange(callback: (event: StateTransitionEvent) => void): void;

  // Get conference info
  getConferenceId(): string | null;
  getParticipantId(): string | null;
}

export class ConferenceStateMachineImpl extends EventEmitter implements ConferenceStateMachine {
  private currentState: ConferenceState = ConferenceState.IDLE;
  private conferenceId: string | null = null;
  private participantId: string | null = null;

  private readonly validTransitions: Map<ConferenceState, ConferenceState[]> = new Map([
    [ConferenceState.IDLE, [ConferenceState.JOINING]],
    [ConferenceState.JOINING, [ConferenceState.CONNECTED, ConferenceState.IDLE]],
    [ConferenceState.CONNECTED, [ConferenceState.LEAVING]],
    [ConferenceState.LEAVING, [ConferenceState.IDLE]],
  ]);

  getCurrentState(): ConferenceState {
    return this.currentState;
  }

  async startJoin(conferenceId: string, participantId: string): Promise<void> {
    if (!this.canTransition(ConferenceState.JOINING)) {
      throw new Error(
        `Cannot transition from ${this.currentState} to ${ConferenceState.JOINING}`
      );
    }

    this.conferenceId = conferenceId;
    this.participantId = participantId;
    this.transition(ConferenceState.JOINING);
  }

  async completeJoin(): Promise<void> {
    if (!this.canTransition(ConferenceState.CONNECTED)) {
      throw new Error(
        `Cannot transition from ${this.currentState} to ${ConferenceState.CONNECTED}`
      );
    }

    this.transition(ConferenceState.CONNECTED);
  }

  async startLeave(): Promise<void> {
    if (!this.canTransition(ConferenceState.LEAVING)) {
      throw new Error(
        `Cannot transition from ${this.currentState} to ${ConferenceState.LEAVING}`
      );
    }

    this.transition(ConferenceState.LEAVING);
  }

  async completeLeave(): Promise<void> {
    if (!this.canTransition(ConferenceState.IDLE)) {
      throw new Error(
        `Cannot transition from ${this.currentState} to ${ConferenceState.IDLE}`
      );
    }

    this.conferenceId = null;
    this.participantId = null;
    this.transition(ConferenceState.IDLE);
  }

  canTransition(to: ConferenceState): boolean {
    const allowedTransitions = this.validTransitions.get(this.currentState);
    return allowedTransitions ? allowedTransitions.includes(to) : false;
  }

  onStateChange(callback: (event: StateTransitionEvent) => void): void {
    this.on('stateChange', callback);
  }

  offStateChange(callback: (event: StateTransitionEvent) => void): void {
    this.off('stateChange', callback);
  }

  getConferenceId(): string | null {
    return this.conferenceId;
  }

  getParticipantId(): string | null {
    return this.participantId;
  }

  private transition(to: ConferenceState): void {
    const from = this.currentState;
    this.currentState = to;

    const event: StateTransitionEvent = {
      from,
      to,
      timestamp: Date.now(),
    };

    this.emit('stateChange', event);
  }
}
