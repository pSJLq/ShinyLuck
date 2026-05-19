// Mappings for the reactive HouseManager — autonomous agent reasoning log.

import { BigInt } from "@graphprotocol/graph-ts";
import { ReasoningRequested } from "../generated/HouseManager/HouseManager";
import { ReasoningLog } from "../generated/schema";

export function handleReasoningRequested(event: ReasoningRequested): void {
  let id = event.transaction.hash.toHex() + "-" + event.logIndex.toString();
  let r = new ReasoningLog(id);
  r.action = event.params.action;
  r.changeBps = event.params.changeBps;
  r.freeBankroll = event.params.freeBankroll;
  r.timestamp = event.params.timestamp;
  r.txHash = event.transaction.hash;
  r.save();
}
