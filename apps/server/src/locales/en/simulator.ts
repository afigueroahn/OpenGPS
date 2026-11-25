// Device simulator of the admin console.
import type { SameShape } from "@opengps/shared";
import type es from "../es/simulator";

const en: SameShape<typeof es> = {
  errors: {
    notFound: "That simulation no longer exists",
    routeNotFound: "That route no longer exists: choose another one",
    brandNotYet: "The simulator does not speak that brand yet",
    identifierInUse: "The identifier {{identifier}} is already in another simulation",
    tooManyDevices: "No more simulated devices fit at once: the maximum is {{max}}. Stop one first",
    notRunning: "That simulated device is stopped: start it first",
    notConnected: "The device is not connected to the gateway yet: wait for it to connect",
    noTank: "That device does not report fuel: turn on “It reports the fuel level” in its options",
    backfillTooLong: "The whole route would be more than {{max}} reports: raise the seconds between reports or use a shorter route",
    routeGone: "That route no longer exists",
    routeInUse_one: "A simulated device travels that route: change its route or delete it first",
    routeInUse_other: "{{count}} simulated devices travel that route: change their route or delete them first",
    routingOff: "The routing service is off. Turn it on in Settings or trace the route with straight lines",
    routingFailed: "The routing service did not answer. Try again in a moment or trace the route with straight lines",
    routingBusy: "Several routes are being traced at once. Wait a few seconds and try again",
    noRoute: "There is no way along streets between those points: move them closer to a street",
    placesOff: "The address service is off or does not take searches. Mark the point on the map",
    placesFailed: "The address service did not answer. Try again or mark the point on the map",
  },
  notCarried: {
    ignition: "That brand does not carry the engine state: remove that option from the route or choose another brand",
    voltage: "That brand does not carry the voltage without the engine state: remove that option from the route or choose another brand",
    sos: "That brand does not carry the panic button: remove that option from the route or choose another brand",
    powerCut: "That brand does not carry the power cut: remove that option from the route or choose another brand",
    tow: "That brand does not carry the tow alarm: remove that option from the route or choose another brand",
    jamming: "That brand does not carry the jamming alarm: remove that option from the route or choose another brand",
    harshAcceleration: "That brand does not carry harsh acceleration: remove that option from the route or choose another brand",
    harshBraking: "That brand does not carry harsh braking: remove that option from the route or choose another brand",
    harshCornering: "That brand does not carry harsh cornering: remove that option from the route or choose another brand",
    fuel: "That brand does not carry the fuel level: remove that option from the route or choose another brand",
    driverKey: "That brand does not carry the driver key: remove that option from the route or choose another brand",
    engineData: "That brand does not carry engine data: remove that option from the route or choose another brand",
    dtc: "That brand does not carry fault codes: remove that option from the route or choose another brand",
    engineCut: "That brand does not carry the engine cut: remove that option from the route or choose another brand",
    lockState: "That brand does not carry the state of the engine cut: remove that option from the route or choose another brand",
    interval: "That brand does not carry the change of interval: remove that option from the route or choose another brand",
    stored: "That brand does not carry reports stored without signal: remove that option from the route or choose another brand",
    extraIo: "That brand does not carry numbered parameters: remove that option from the route or choose another brand",
  },
};
export default en;
