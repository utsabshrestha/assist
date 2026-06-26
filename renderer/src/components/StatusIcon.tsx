import React from 'react';
import { Clock, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { TodoStatus } from '../types/electron.js';

interface StatusIconProps {
  status: TodoStatus;
  size?: number;
  className?: string;
}

const STATUS_CONFIG: Record<TodoStatus, { Icon: React.FC<any>; color: string; spin?: boolean }> = {
  'not-started': { Icon: Clock, color: 'text-[#a8a29e]' },
  'in-progress': { Icon: Loader2, color: 'text-[#2563eb]', spin: true },
  'completed': { Icon: CheckCircle2, color: 'text-[#16a34a]' },
  'failed': { Icon: XCircle, color: 'text-[#dc2626]' },
  'blocked': { Icon: AlertTriangle, color: 'text-[#d97706]' },
};

export const StatusIcon: React.FC<StatusIconProps> = ({ status, size = 14, className = '' }) => {
  const { Icon, color, spin } = STATUS_CONFIG[status];
  return (
    <Icon
      size={size}
      strokeWidth={2.25}
      className={`flex-shrink-0 ${color} ${spin ? 'animate-spin' : ''} ${className}`}
    />
  );
};
