"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => {
  return () => {};
};

export function useMounted() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
