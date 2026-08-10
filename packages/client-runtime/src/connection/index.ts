// Connection model + reconnect supervisor.
export {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionBlockedReason,
  type ConnectionPhase,
  type ConnectionState,
  ConnectionTransientError,
  ConnectionTransientReason,
  INITIAL_CONNECTION_STATE,
  type NetworkStatus,
  type PreparedConnection,
} from "./model.ts";
export { bearerBootstrapBlockedReason, mapBearerBootstrapError } from "./errors.ts";
export {
  Connectivity,
  type ConnectivityShape,
  layer as connectivityLayer,
} from "./connectivity.ts";
export {
  type ConnectionWakeup,
  ConnectionWakeups,
  type ConnectionWakeupsShape,
  isApplicationActiveWakeup,
  layer as connectionWakeupsLayer,
  shouldResubscribeAfterWakeup,
} from "./wakeups.ts";
export { ConnectionSupervisor, layer as connectionSupervisorLayer, start } from "./supervisor.ts";
