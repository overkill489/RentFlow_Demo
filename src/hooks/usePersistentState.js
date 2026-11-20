import { useEffect, useState } from "react";

export default function usePersistentState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);

      return saved !== null ? JSON.parse(saved) : initialValue;
    } catch (error) {
      console.warn("Could not load saved demo data:", error);
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.warn("Could not save demo data:", error);
    }
  }, [key, value]);

  return [value, setValue];
}
