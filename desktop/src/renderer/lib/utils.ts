import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's class helper: joins classes and lets a later Tailwind class win over an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
