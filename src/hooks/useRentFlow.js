import { useEffect, useMemo, useRef, useState } from "react";

import { rentflowApi } from "../services/rentflowApi";
import { toLocalDateTimeInput } from "../utils/formatters";

export default function useRentFlow(companyId) {
  const [quotes, setQuotes] = useState([]);
  const [queue, setQueue] = useState([]);
  const [activityLog, setActivityLog] = useState({});
  const [loadedCompanyId, setLoadedCompanyId] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [notification, setNotification] = useState("");

  const [form, setForm] = useState({
    customer: "",
    equipment: "",
    amount: "",
  });

  const [selectedQuoteId, setSelectedQuoteId] = useState(null);
  const [followUpDate, setFollowUpDate] = useState("");
  const [currentTime, setCurrentTime] = useState(Date.now);

  const activeCompanyRef = useRef(companyId);
  const selectedQuoteRef = useRef(null);
  const pendingRef = useRef(false);

  activeCompanyRef.current = companyId;

  const isCurrentCompany = loadedCompanyId === companyId;

  const companyQuotes = isCurrentCompany ? quotes : [];
  const companyQueue = isCurrentCompany ? queue : [];
  const companyActivity = isCurrentCompany ? activityLog : {};

  useEffect(() => {
    let active = true;

    selectedQuoteRef.current = null;

    setQuotes([]);
    setQueue([]);
    setActivityLog({});
    setLoadedCompanyId(null);
    setSelectedQuoteId(null);
    setFollowUpDate("");
    setShowForm(false);
    setSearch("");
    setFilter("All");
    setNotification("");
    setError("");
    setBusy(false);
    pendingRef.current = false;

    if (!companyId) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);

    Promise.all([rentflowApi.getQuotes(), rentflowApi.getFollowUps()])
      .then(([nextQuotes, nextQueue]) => {
        if (!active) return;

        setQuotes(nextQuotes);
        setQueue(nextQueue);
        setLoadedCompanyId(companyId);
      })
      .catch((err) => {
        if (!active) return;

        setError(err.message);
        setNotification(err.message);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [companyId]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const refresh = async () => {
    if (!companyId) return;

    const [nextQuotes, nextQueue] = await Promise.all([
      rentflowApi.getQuotes(),
      rentflowApi.getFollowUps(),
    ]);

    if (activeCompanyRef.current !== companyId) return;

    setQuotes(nextQuotes);
    setQueue(nextQueue);
    setLoadedCompanyId(companyId);
    setError("");
  };

  const selectedQuote =
    companyQuotes.find((quote) => quote.id === selectedQuoteId) ?? null;

  const followUps = useMemo(() => {
    return Object.fromEntries(
      companyQueue.map((item) => [item.quoteId, item.scheduledAt]),
    );
  }, [companyQueue]);

  const selectedFollowUp = selectedQuote
    ? (followUps[selectedQuote.id] ?? null)
    : null;

  const selectedActivity = selectedQuote
    ? (companyActivity[selectedQuote.id] ?? [])
    : [];

  const followUpQueue = useMemo(() => {
    const quoteMap = new Map(companyQuotes.map((quote) => [quote.id, quote]));

    return companyQueue
      .map((item) => {
        const quote = quoteMap.get(item.quoteId);

        if (!quote || quote.status === "Accepted") {
          return null;
        }

        const scheduledTime = new Date(item.scheduledAt).getTime();

        if (!Number.isFinite(scheduledTime)) {
          return null;
        }

        return {
          ...quote,
          scheduledAt: item.scheduledAt,
          scheduledTime,
          isDue: scheduledTime <= currentTime,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  }, [companyQuotes, companyQueue, currentTime]);

  const overdueCount = followUpQueue.filter((item) => item.isDue).length;

  const actionDueCount =
    companyQuotes.filter(
      (quote) => quote.status === "Follow-up Due" && !followUps[quote.id],
    ).length + overdueCount;

  const stats = useMemo(() => {
    const active = companyQuotes.filter((quote) => quote.status !== "Accepted");

    return {
      total: companyQuotes.length,
      outstanding: active.reduce((sum, quote) => sum + Number(quote.amount), 0),
      followups: companyQuotes.filter(
        (quote) => quote.status === "Follow-up Due",
      ).length,
      accepted: companyQuotes.filter((quote) => quote.status === "Accepted")
        .length,
    };
  }, [companyQuotes]);

  const filteredQuotes = useMemo(() => {
    const term = search.toLowerCase().trim();

    return companyQuotes.filter((quote) => {
      const matchesSearch =
        quote.customer.toLowerCase().includes(term) ||
        quote.equipment.toLowerCase().includes(term) ||
        quote.id.toLowerCase().includes(term);

      const matchesFilter = filter === "All" || quote.status === filter;

      return matchesSearch && matchesFilter;
    });
  }, [companyQuotes, search, filter]);

  const loadActivity = async (quoteId) => {
    try {
      const activity = await rentflowApi.getActivity(quoteId);

      if (
        activeCompanyRef.current !== companyId ||
        selectedQuoteRef.current !== quoteId
      ) {
        return;
      }

      setActivityLog((current) => ({
        ...current,
        [quoteId]: activity,
      }));
    } catch (err) {
      if (
        activeCompanyRef.current === companyId &&
        selectedQuoteRef.current === quoteId
      ) {
        setNotification(err.message);
      }
    }
  };

  const openQuote = (quoteId) => {
    const quote = companyQuotes.find((item) => item.id === quoteId);

    if (!quote) return;

    selectedQuoteRef.current = quoteId;
    setSelectedQuoteId(quoteId);

    setFollowUpDate(toLocalDateTimeInput(followUps[quoteId]));

    loadActivity(quoteId);
  };

  const closeQuote = () => {
    selectedQuoteRef.current = null;
    setSelectedQuoteId(null);
    setFollowUpDate("");
  };

  const runAction = async (action) => {
    if (pendingRef.current || !companyId) return;

    pendingRef.current = true;
    setBusy(true);
    setError("");

    try {
      await action();
    } catch (err) {
      if (activeCompanyRef.current === companyId) {
        setError(err.message);
        setNotification(err.message);
      }
    } finally {
      pendingRef.current = false;

      if (activeCompanyRef.current === companyId) {
        setBusy(false);
      }
    }
  };

  const updateStatus = (id, status) => {
    const quote = companyQuotes.find((item) => item.id === id);

    if (!quote || quote.status === status) return;

    return runAction(async () => {
      await rentflowApi.updateQuoteStatus(id, status);
      await refresh();

      if (selectedQuoteRef.current === id) {
        await loadActivity(id);
      }

      setNotification(`Quote updated to ${status}.`);
    });
  };

  const scheduleFollowUp = (event) => {
    event.preventDefault();

    if (!selectedQuote) return;

    const quoteId = selectedQuote.id;
    const date = new Date(followUpDate);

    if (!Number.isFinite(date.getTime())) {
      setNotification("Choose a valid follow-up date.");
      return;
    }

    if (date.getTime() <= Date.now()) {
      setNotification("Choose a future follow-up date.");
      return;
    }

    return runAction(async () => {
      await rentflowApi.scheduleFollowUp(quoteId, date.toISOString());

      await refresh();
      await loadActivity(quoteId);

      setNotification("Follow-up saved to the database. No email was sent.");
    });
  };

  const simulateFollowUp = (message) => {
    if (!selectedQuote) return;

    if (typeof message !== "string" || !message.trim()) {
      setNotification("The message cannot be empty.");
      return;
    }

    const quoteId = selectedQuote.id;

    return runAction(async () => {
      const result = await rentflowApi.simulateFollowUp(quoteId);

      await refresh();
      await loadActivity(quoteId);

      setFollowUpDate("");
      setNotification(result.message);
    });
  };

  const addQuote = (event) => {
    event.preventDefault();

    const amount = Number(form.amount);

    if (
      !form.customer.trim() ||
      !form.equipment.trim() ||
      form.amount === "" ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setNotification("Enter valid quote details.");
      return;
    }

    return runAction(async () => {
      await rentflowApi.createQuote({
        customer: form.customer.trim(),
        equipment: form.equipment.trim(),
        amount,
      });

      await refresh();

      setForm({
        customer: "",
        equipment: "",
        amount: "",
      });

      setShowForm(false);
      setFilter("All");
      setSearch("");

      setNotification("Quote saved to the database.");
    });
  };

  const resetDemo = async () => {
    if (pendingRef.current || !companyId) return;

    pendingRef.current = true;
    setBusy(true);

    try {
      await refresh();
      setNotification("Company data refreshed successfully.");
    } catch (err) {
      setError(err.message);
      setNotification(err.message);
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  return {
    quotes: companyQuotes,
    followUps,
    activityLog: companyActivity,
    stats,
    filteredQuotes,
    followUpQueue,
    overdueCount,
    actionDueCount,
    search,
    setSearch,
    filter,
    setFilter,
    showForm,
    setShowForm,
    notification,
    setNotification,
    form,
    setForm,
    selectedQuote,
    selectedFollowUp,
    selectedActivity,
    followUpDate,
    setFollowUpDate,
    openQuote,
    closeQuote,
    updateStatus,
    scheduleFollowUp,
    simulateFollowUp,
    addQuote,
    resetDemo,
    refresh,
    loading,
    error,
    busy,
    ready: isCurrentCompany,
  };
}
