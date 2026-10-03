import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api } from '@/lib/api';
import { AdminContentLibraryPanel } from '@/components/AdminContentLibraryPanel';
import { AdminPersonalWordsPanel } from '@/components/AdminPersonalWordsPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AdminWordsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState('content');
  const [catalogRevision, setCatalogRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void api.wordAdminStatus().then(value => { if (active) setAllowed(value.isAdmin); }).catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, []);

  if (allowed === null) return <main className="mx-auto max-w-6xl p-6">Checking admin access…</main>;
  if (!allowed) return <main className="mx-auto max-w-6xl p-6"><h1 className="font-serif text-3xl">Admin access required</h1><p className="mt-2">Only Firebase UIDs configured on the server can manage admin content or another user’s cards.</p><Link href="/cabinet" className="underline">Back to Cabinet</Link></main>;

  return <main className="mx-auto max-w-6xl space-y-6 p-4 pb-20 sm:p-8" data-testid="admin-words">
    <header><p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Administration</p><h1 className="font-serif text-3xl">Words &amp; content</h1><p className="mt-2 text-sm text-muted-foreground">Admin-owned learning content is kept separate from personal cards. Choose a workspace below.</p></header>
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList aria-label="Admin words workspaces" className="h-auto w-full justify-start gap-1 overflow-x-auto sm:w-auto">
        <TabsTrigger value="content" className="px-4 py-2">Admin content</TabsTrigger>
        <TabsTrigger value="personal" className="px-4 py-2">Personal cards</TabsTrigger>
      </TabsList>
      <TabsContent value="content" className="mt-5"><AdminContentLibraryPanel key={catalogRevision} /></TabsContent>
      <TabsContent value="personal" className="mt-5"><AdminPersonalWordsPanel onContentChanged={() => { setCatalogRevision(revision => revision + 1); setActiveTab('content'); }} /></TabsContent>
    </Tabs>
  </main>;
}
