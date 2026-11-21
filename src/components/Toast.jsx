import { X } from "lucide-react";
export default function Toast({ notification, onDismiss }) {
  return (
        <div className="toast" role="status">
          <span>{notification}</span>
          <button
            onClick={() => onDismiss()}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
  );
}
