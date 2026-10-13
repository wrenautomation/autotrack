/**
 * Shipping closed segments off the laptop. The recorder calls `ship()` every 5 minutes; the real
 * shipper (S3, delete after put, local cap) plugs in here.
 */

export interface ShipResult {
  put: number; // segments shipped and deleted locally
  failed: number; // segments that stay for the next pass
}

export interface Shipper {
  /** One pass over closed (`.done`) segments under `sessionsDir`. Never throws. */
  ship(sessionsDir: string): Promise<ShipResult>;
}

export const noShipper: Shipper = {
  ship: async () => ({ put: 0, failed: 0 }),
};
