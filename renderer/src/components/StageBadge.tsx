import React from 'react';
import type { AgentStage } from '../types/electron.js';

interface StageBadgeProps {
  stage: AgentStage;
  size?: 'sm' | 'md';
}

const STAGE_CONFIG: Record<AgentStage, { label: string; color: string }> = {
  idle:           { label: 'Idle',         color: 'text-[#78716c] bg-[#f5f5f4] border border-[#e7e5e4]' },
  planning:       { label: 'Planning',     color: 'text-[#92400e] bg-[#fef3c7] border border-[#fde68a]' },
  categorization: { label: 'Categorizing', color: 'text-[#4c1d95] bg-[#ede9fe] border border-[#ddd6fe]' },
  execution:      { label: 'Executing',    color: 'text-[#064e3b] bg-[#d1fae5] border border-[#a7f3d0]' },
  done:           { label: 'Done',         color: 'text-[#0c4a6e] bg-[#e0f2fe] border border-[#bae6fd]' },
};

export const StageBadge: React.FC<StageBadgeProps> = ({ stage, size = 'sm' }) => {
  const config = STAGE_CONFIG[stage];
  const sizeClass = size === 'md' ? 'px-2.5 py-0.5 text-xs' : 'px-2 py-0.5 text-[10px]';

  return (
    <span className={`inline-flex items-center rounded-full font-medium ${sizeClass} ${config.color}`}>
      {config.label}
    </span>
  );
};

export const STAGE_AGENT_NAME: Record<AgentStage, string> = {
  idle:           'File Assist',
  planning:       'Planner Agent',
  categorization: 'Categorization Agent',
  execution:      'Execution Agent',
  done:           'File Assist',
};
