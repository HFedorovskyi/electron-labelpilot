import React, { useState } from 'react';
import { X, Check, ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';

interface DatePickerModalProps {
    value: Date;
    onUpdate: (date: Date) => void;
    onClose: () => void;
    title?: string;
}

const DatePickerModal: React.FC<DatePickerModalProps> = ({ value, onUpdate, onClose, title = 'Выберите дату' }) => {
    const [currentMonth, setCurrentMonth] = useState(new Date(value.getFullYear(), value.getMonth(), 1));
    const [selectedDate, setSelectedDate] = useState(new Date(value.getFullYear(), value.getMonth(), value.getDate()));

    const nextMonth = () => {
        setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
    };

    const prevMonth = () => {
        setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
    };

    const handleSelect = (day: number) => {
        setSelectedDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day));
    };

    const handleConfirm = () => {
        onUpdate(selectedDate);
        onClose();
    };

    const handleToday = () => {
        const today = new Date();
        setSelectedDate(today);
        setCurrentMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    };

    const daysInMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0).getDate();
    const firstDayIndex = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1).getDay();
    // Adjust for Monday as first day of week (0 = Monday, 6 = Sunday for UI)
    const startDay = firstDayIndex === 0 ? 6 : firstDayIndex - 1;

    const days = [];
    for (let i = 0; i < startDay; i++) {
        days.push(null);
    }
    for (let i = 1; i <= daysInMonth; i++) {
        days.push(i);
    }

    const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
            <div className="bg-neutral-900 border border-white/10 rounded-[2.5rem] p-8 w-[450px] shadow-2xl relative animate-in zoom-in-95 duration-200">
                <button
                    onClick={onClose}
                    className="absolute top-6 right-6 p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors"
                >
                    <X className="w-8 h-8 text-neutral-400" />
                </button>

                <h3 className="text-2xl font-bold text-white mb-6 text-center">{title}</h3>

                <div className="flex items-center justify-between mb-6">
                    <button onClick={prevMonth} className="p-3 bg-neutral-700 hover:bg-neutral-600 rounded-2xl transition-colors">
                        <ChevronLeft className="w-6 h-6 text-white" />
                    </button>
                    <div className="text-xl font-bold text-emerald-400">
                        {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
                    </div>
                    <button onClick={nextMonth} className="p-3 bg-neutral-700 hover:bg-neutral-600 rounded-2xl transition-colors">
                        <ChevronRight className="w-6 h-6 text-white" />
                    </button>
                </div>

                <div className="grid grid-cols-7 gap-2 mb-2">
                    {weekDays.map(d => (
                        <div key={d} className="text-center text-sm font-bold text-neutral-500 py-2">{d}</div>
                    ))}
                </div>

                <div className="grid grid-cols-7 gap-2 mb-6">
                    {days.map((day, idx) => {
                        if (day === null) return <div key={`empty-${idx}`} className="h-12" />;

                        const isSelected = selectedDate.getDate() === day && selectedDate.getMonth() === currentMonth.getMonth() && selectedDate.getFullYear() === currentMonth.getFullYear();
                        const isToday = new Date().getDate() === day && new Date().getMonth() === currentMonth.getMonth() && new Date().getFullYear() === currentMonth.getFullYear();

                        return (
                            <button
                                key={`day-${day}`}
                                onClick={() => handleSelect(day)}
                                className={`h-12 rounded-xl text-lg font-bold flex items-center justify-center transition-all active:scale-95 ${isSelected ? 'bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.6)] border-2 border-emerald-200 scale-110 z-10' :
                                    isToday ? 'bg-neutral-700 text-emerald-400 border border-emerald-500/50 hover:bg-neutral-600' :
                                        'bg-neutral-700 text-white hover:bg-neutral-600 shadow-sm'
                                    }`}
                            >
                                {day}
                            </button>
                        );
                    })}
                </div>

                <div className="flex gap-4">
                    <button
                        onClick={handleToday}
                        className="flex-1 py-4 bg-neutral-700 hover:bg-neutral-600 text-white rounded-2xl font-bold flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                    >
                        <CalendarIcon className="w-5 h-5" />
                        Сегодня
                    </button>
                    <button
                        onClick={handleConfirm}
                        className="flex-1 py-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98]"
                    >
                        <Check className="w-5 h-5" />
                        OK
                    </button>
                </div>
            </div>
        </div>
    );
};

export default DatePickerModal;
