import React from 'react';
import type { AgentStage } from '../types/electron.js';

interface StageProgressBarProps {
  stage: AgentStage;
}

const STAGES: { key: AgentStage; label: string }[] = [
  { key: 'planning',       label: 'Planning'      },
  { key: 'categorization', label: 'Categorizing'  },
  { key: 'execution',      label: 'Executing'     },
  { key: 'done',           label: 'Complete'      },
];

const STAGE_ORDER: Record<AgentStage, number> = {
  idle: -1, planning: 0, categorization: 1, execution: 2, done: 3
};

export const StageProgressBar: React.FC<StageProgressBarProps> = ({ stage }) => {
  const currentOrder = STAGE_ORDER[stage];

  return (
    <div className="flex items-center gap-0 px-6 py-2.5">
      {STAGES.map((s, i) => {
        const order = STAGE_ORDER[s.key];
        const isCompleted = order < currentOrder;
        const isActive = s.key === stage;

        return (
          <React.Fragment key={s.key}>
            <div className="flex items-center gap-2">
              {/* Step dot */}
              <div className={`
                w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-bold
                transition-all duration-300 flex-shrink-0
                ${isActive
                  ? 'bg-[#2563eb] border-[#2563eb] text-white'
                  : isCompleted
                  ? 'bg-[#059669] border-[#059669] text-white'
                  : 'bg-white border-[#d6d3d1] text-[#a8a29e]'
                }
              `}>
                {isCompleted ? '✓' : i + 1}
              </div>
              <span className={`text-xs font-medium ${
                isActive ? 'text-[#2563eb]' : isCompleted ? 'text-[#059669]' : 'text-[#a8a29e]'
              }`}>
                {s.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div className={`flex-1 h-px mx-2 ${isCompleted ? 'bg-[#059669]' : 'bg-[#e7e5e4]'}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
