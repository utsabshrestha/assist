import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TodoItem } from '../types/electron.js';
import { StatusIcon } from './StatusIcon.js';

interface TodoListPanelProps {
  todoList: TodoItem[];
}

const TaskRow: React.FC<{ task: TodoItem }> = ({ task }) => {
  const [collapsed, setCollapsed] = useState(false);
  const hasSubTasks = !!task.subTasks && task.subTasks.length > 0;

  return (
    <div className="px-4 py-2.5">
      <button
        onClick={() => hasSubTasks && setCollapsed(c => !c)}
        className={`flex items-start gap-2 w-full text-left ${hasSubTasks ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {hasSubTasks && (
          <ChevronRight
            size={12}
            strokeWidth={2.5}
            className={`flex-shrink-0 mt-1 text-[#a8a29e] transition-transform duration-150 ${collapsed ? '' : 'rotate-90'}`}
          />
        )}
        <StatusIcon status={task.status} className="mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-[#1c1917]">{task.title}</div>
          <div className="flex flex-wrap gap-1 mt-1">
            {task.extensionList.map(ext => (
              <span
                key={ext}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#f5f5f4] text-[#78716c]"
              >
                {ext}
              </span>
            ))}
          </div>
        </div>
      </button>

      {hasSubTasks && !collapsed && (
        <div className="mt-2 ml-6 space-y-1">
          {task.subTasks!.map(sub => (
            <div key={sub.extension} className="flex items-center gap-1.5">
              <StatusIcon status={sub.status} size={12} />
              <span className="text-[11px] font-mono text-[#78716c]">{sub.extension}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const TodoListPanel: React.FC<TodoListPanelProps> = ({ todoList }) => {
  if (todoList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-8">
        <p className="text-sm text-[#a8a29e]">No tasks yet</p>
        <p className="text-xs text-[#c4bfbb]">The organization plan will appear here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[#f5f5f4]">
      {todoList.map(task => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
};
