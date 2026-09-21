import type { TypedEventBus } from "@finance/core";
import { BaseServiceWrapper } from "../core/service-wrapper.js";
import { ApprovalService } from "./approval-service.js";
import type { ApprovalServiceOptions } from "./types.js";

export class ApprovalServiceWrapper extends BaseServiceWrapper<ApprovalService> {
  constructor(opts: ApprovalServiceOptions & { bus: TypedEventBus }) {
    const inner = new ApprovalService(opts);
    super(
      { id: "approvals", name: "Trade Approvals", description: "Human-in-the-loop trade proposals: quant signals held for Approve/Reject" },
      inner,
      { onStart: (s) => s.start(), onStop: (s) => s.stop() }
    );
  }
}
