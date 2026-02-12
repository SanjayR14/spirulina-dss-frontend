import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function cleanMarkdownBold(input: string | undefined | null): string {
  if (!input) return "";

  // Strip markdown bold markers while keeping inner text.
  return input.replace(/\*\*(.*?)\*\*/g, "$1");
}

