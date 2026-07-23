import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { useLlmConfig, useSaveLlmConfig } from '@/hooks/useConfig';
import { useUserProfile, normalizeGithubUsername } from '@/hooks/useUserProfile';
import { fetchOllamaModels, fetchLlamaCppModels, testLlmConfig } from '@/lib/api';
import type { AnalysisLanguage } from '@/lib/types';
import { useLocale } from '@/i18n/LocaleProvider';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  CheckCircle,
  XCircle,
  Cpu,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  Minus,
  User,
} from 'lucide-react';

// TODO: tech debt — duplicated provider types (this local type mirrors dashboard/src/lib/types.ts LLMConfig.provider)
type LLMProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'llamacpp';

interface ProviderInfo {
  id: LLMProvider;
  name: string;
  requiresApiKey: boolean;
  apiKeyLink?: string;
  models: Array<{ id: string; name: string; description?: string }>;
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    apiKeyLink: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', description: 'Best' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', description: 'Fast & cheap' },
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Fallback' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    apiKeyLink: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most capable' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Best balance' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', description: 'Fast & cheap' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    requiresApiKey: true,
    apiKeyLink: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Capable' },
      { id: 'gemma-3-27b-it', name: 'Gemma 4 27B IT', description: 'Free via Gemini API' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    requiresApiKey: false,
    models: [
      { id: 'llama3.3', name: 'Llama 3.3' },
      { id: 'qwen3:14b', name: 'Qwen3 14B' },
      { id: 'mistral', name: 'Mistral' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
      { id: 'gemma4', name: 'Gemma 4 12B' },
      { id: 'gemma4:27b', name: 'Gemma 4 27B' },
    ],
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (Local)',
    requiresApiKey: false,
    models: [
      { id: 'gemma-4-12b', name: 'Gemma 4 12B (Q4_K_M)', description: 'Flagship local model' },
      { id: 'gemma-4-27b', name: 'Gemma 4 27B (Q4_K_M)', description: 'Large local model' },
      { id: 'custom', name: 'Custom model', description: 'Any GGUF loaded in llama-server' },
    ],
  },
];

export default function SettingsPage() {
  const { t } = useLocale();
  const { data: llmConfig, isLoading: configLoading } = useLlmConfig();
  const saveMutation = useSaveLlmConfig();
  const { profile, saveProfile } = useUserProfile();

  // Profile card state
  const [profileName, setProfileName] = useState(profile?.name ?? '');
  const [profileGithubUsername, setProfileGithubUsername] = useState(profile?.githubUsername ?? '');
  const [profileAvatarError, setProfileAvatarError] = useState(false);

  // Sync profile fields when profile loads from localStorage
  useEffect(() => {
    setProfileName(profile?.name ?? '');
    setProfileGithubUsername(profile?.githubUsername ?? '');
    setProfileAvatarError(false);
  }, [profile?.name, profile?.githubUsername]);

  const profileNormalizedUsername = normalizeGithubUsername(profileGithubUsername);
  const profileAvatarUrl = profileNormalizedUsername
    ? `https://github.com/${profileNormalizedUsername}.png`
    : '';

  const handleSaveProfile = async () => {
    await saveProfile(profileName, profileGithubUsername);
    toast.success(t('settings.profile.saved'));
  };

  const [llmProvider, setLlmProvider] = useState<LLMProvider>('openai');
  const [llmModel, setLlmModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [analysisLanguage, setAnalysisLanguage] = useState<AnalysisLanguage>('auto');
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestError, setLlmTestError] = useState<string | null>(null);
  const [ollamaDiscoveredModels, setOllamaDiscoveredModels] = useState<string[]>([]);
  const [ollamaCorsOpen, setOllamaCorsOpen] = useState(false);
  const [llamacppDiscoveredModels, setLlamacppDiscoveredModels] = useState<string[]>([]);
  const [llamacppDiscovering, setLlamacppDiscovering] = useState(false);
  const supportsCustomBaseUrl = llmConfig?.providers?.some(
    (provider) => provider.id === llmProvider && provider.supportsCustomBaseUrl,
  ) ?? false;

  // Populate form from loaded config
  useEffect(() => {
    if (!llmConfig) return;
    setAnalysisLanguage(llmConfig.analysisLanguage ?? 'auto');
    if (llmConfig.provider) {
      setLlmProvider(llmConfig.provider);
      setLlmConfigured(true);
    }
    if (llmConfig.model) {
      // If saved model doesn't match any preset, populate the custom input instead
      const providerInfo = PROVIDERS.find((p) => p.id === (llmConfig.provider ?? llmProvider));
      const isPreset = providerInfo?.models.some((m) => m.id === llmConfig.model);
      if (isPreset) {
        setLlmModel(llmConfig.model);
        setCustomModel('');
      } else {
        setCustomModel(llmConfig.model);
        setLlmModel(providerInfo?.models[0]?.id ?? '');
      }
    }
    // apiKey is masked by server — leave blank for re-entry
    if (llmConfig.baseUrl) setLlmBaseUrl(llmConfig.baseUrl);
  }, [llmConfig]);

  const handleAnalysisLanguageChange = async (nextLanguage: AnalysisLanguage) => {
    const previousLanguage = analysisLanguage;
    setAnalysisLanguage(nextLanguage);
    try {
      await saveMutation.mutateAsync({ analysisLanguage: nextLanguage });
      toast.success(t('settings.analysisLanguage.saved'));
    } catch (error) {
      setAnalysisLanguage(previousLanguage);
      toast.error(error instanceof Error ? error.message : t('settings.analysisLanguage.saveFailed'));
    }
  };

  // Default model when provider changes
  useEffect(() => {
    const providerInfo = PROVIDERS.find((p) => p.id === llmProvider);
    if (providerInfo?.models[0] && !llmModel) {
      setLlmModel(providerInfo.models[0].id);
    }
  }, [llmProvider, llmModel]);

  // Discover Ollama models
  useEffect(() => {
    if (llmProvider !== 'ollama') return;
    fetchOllamaModels(llmBaseUrl || undefined)
      .then((r) => setOllamaDiscoveredModels(r.models.map((m) => m.name)))
      .catch(() => {});
  }, [llmProvider, llmBaseUrl]);

  // Handler to manually discover llamacpp models via the Discover button
  const handleDiscoverLlamaCppModels = () => {
    setLlamacppDiscovering(true);
    fetchLlamaCppModels(llmBaseUrl || undefined)
      .then((r) => {
        const names = r.models.map((m) => m.id);
        setLlamacppDiscoveredModels(names);
        if (names.length > 0 && !llmModel) {
          setLlmModel(names[0]);
        }
      })
      .catch(() => {})
      .finally(() => setLlamacppDiscovering(false));
  };

  const handleProviderChange = (provider: LLMProvider) => {
    setLlmProvider(provider);
    setLlmConfigured(false);
    setLlmTestError(null);
    setLlmApiKey('');
    setLlmBaseUrl('');
    setCustomModel('');
    const providerInfo = PROVIDERS.find((p) => p.id === provider);
    setLlmModel(providerInfo?.models[0]?.id ?? '');
  };

  const handleSaveLLMConfig = async () => {
    const providerInfo = PROVIDERS.find((p) => p.id === llmProvider);
    if (!providerInfo) return;

    // Custom model input overrides the dropdown selection for cloud providers
    const effectiveModel = customModel.trim() || llmModel;

    if (providerInfo.requiresApiKey && !llmApiKey) {
      setLlmTestError(t('settings.ai.apiKeyRequired'));
      return;
    }
    if (!effectiveModel) {
      setLlmTestError(t('settings.ai.modelRequired'));
      return;
    }

    setLlmTesting(true);
    setLlmTestError(null);

    try {
      const testResult = await testLlmConfig({
        provider: llmProvider,
        model: effectiveModel,
        apiKey: llmApiKey || undefined,
        ...(supportsCustomBaseUrl && llmBaseUrl
          ? { baseUrl: llmBaseUrl }
          : {}),
      });

      if (testResult.success) {
        await saveMutation.mutateAsync({
          provider: llmProvider,
          model: effectiveModel,
          apiKey: llmApiKey || undefined,
          ...(supportsCustomBaseUrl && llmBaseUrl
            ? { baseUrl: llmBaseUrl }
            : {}),
        });
        setLlmConfigured(true);
        setLlmTestError(null);
        toast.success(t('settings.ai.configured'));
      } else {
        setLlmTestError(testResult.error || t('settings.ai.connectFailed'));
      }
    } catch (err) {
      setLlmTestError(err instanceof Error ? err.message : t('settings.ai.saveFailed'));
    } finally {
      setLlmTesting(false);
    }
  };

  const handleClearLLMConfig = async () => {
    try {
      await saveMutation.mutateAsync({ provider: undefined, model: undefined, apiKey: undefined });
      setLlmConfigured(false);
      setLlmApiKey('');
      setCustomModel('');
      setLlmTestError(null);
      toast.success(t('settings.ai.cleared'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('settings.ai.clearFailed');
      setLlmTestError(msg);
      toast.error(msg);
    }
  };

  const progressItems = [
    { label: t('settings.ai.progressLabel'), done: llmConfigured, required: true },
  ];
  const requiredDone = progressItems.filter((p) => p.required && p.done).length;
  const requiredTotal = progressItems.filter((p) => p.required).length;

  if (configLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
          <p className="text-muted-foreground">{t('settings.subtitle')}</p>
        </div>
        <div className="h-32 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('settings.title')}</h1>
        <p className="text-muted-foreground">{t('settings.subtitle')}</p>
      </div>

      {/* User Profile Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle className="text-base">{t('settings.profile.title')}</CardTitle>
          </div>
          <CardDescription>
            {t('settings.profile.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Live avatar preview */}
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-full overflow-hidden bg-muted border border-border shrink-0 flex items-center justify-center">
              {profileAvatarUrl && !profileAvatarError ? (
                <img
                  src={profileAvatarUrl}
                  alt={t('settings.profile.avatarAlt')}
                  className="h-full w-full object-cover"
                  onError={() => setProfileAvatarError(true)}
                  onLoad={() => setProfileAvatarError(false)}
                />
              ) : (
                <span className="text-xl text-muted-foreground select-none">
                  {profileName.trim().charAt(0).toUpperCase() || '?'}
                </span>
              )}
            </div>
            <div className="text-sm">
              <p className="font-medium">{profileName.trim() || t('settings.profile.defaultName')}</p>
              {profileNormalizedUsername ? (
                <p className="text-muted-foreground text-xs">@{profileNormalizedUsername}</p>
              ) : (
                <p className="text-muted-foreground text-xs italic">{t('settings.profile.enterGithub')}</p>
              )}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">{t('settings.profile.displayName')}</label>
            <Input
              className="mt-1"
              placeholder={t('settings.profile.displayPlaceholder')}
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-sm font-medium">{t('settings.profile.githubUsername')}</label>
            <Input
              className="mt-1"
              placeholder={t('settings.profile.githubPlaceholder')}
              value={profileGithubUsername}
              onChange={(e) => {
                setProfileGithubUsername(e.target.value);
                setProfileAvatarError(false);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('settings.profile.githubHelp')}
            </p>
          </div>

          <Button
            onClick={handleSaveProfile}
            disabled={!profileName.trim() || !profileNormalizedUsername}
          >
            {t('settings.profile.save')}
          </Button>
        </CardContent>
      </Card>

      {/* Setup progress strip */}
      <div className="rounded-lg border bg-card px-4 py-3 flex items-center gap-4 flex-wrap">
        <span className="text-sm font-medium shrink-0">
          {t('settings.setup.progress', { done: requiredDone, total: requiredTotal })}
        </span>
        <div className="flex items-center gap-3 flex-wrap">
          {progressItems.map((item) => (
            <div key={item.label} className="flex items-center gap-1.5 text-xs">
              {item.done ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Minus className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={item.done ? 'text-foreground' : 'text-muted-foreground'}>
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* LLM Provider Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5" />
              <CardTitle className="text-base">{t('settings.ai.title')}</CardTitle>
            </div>
            {llmConfigured ? (
              <Badge variant="outline" className="text-green-600 border-green-600">
                <CheckCircle className="mr-1 h-3 w-3" />
                {t('settings.ai.connected')}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-amber-600 border-amber-600">
                <XCircle className="mr-1 h-3 w-3" />
                {t('settings.ai.notConfigured')}
              </Badge>
            )}
          </div>
          <CardDescription>
            {t('settings.ai.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="text-sm font-medium">{t('settings.ai.provider')}</label>
            <Select
              value={llmProvider}
              onValueChange={(v) => handleProviderChange(v as LLMProvider)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t('settings.ai.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.id === 'ollama'
                      ? `Ollama (${t('settings.ai.local')})`
                      : provider.id === 'llamacpp'
                        ? `llama.cpp (${t('settings.ai.local')})`
                        : provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selection */}
          <div>
            <label className="text-sm font-medium">{t('settings.ai.model')}</label>
            {llmProvider === 'ollama' ? (
              <div className="mt-1 space-y-2">
                <Input
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder={t('settings.ai.ollamaModelPlaceholder')}
                />
                {(() => {
                  const hardcoded =
                    PROVIDERS.find((p) => p.id === 'ollama')?.models.map((m) => m.id) ?? [];
                  const suggestions = [...new Set([...hardcoded, ...ollamaDiscoveredModels])];
                  return suggestions.length > 0 ? (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">{t('settings.ai.suggestions')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {suggestions.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setLlmModel(name)}
                            className="text-xs px-2 py-0.5 rounded-md border border-border bg-muted hover:bg-accent hover:text-accent-foreground transition-colors"
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            ) : llmProvider === 'llamacpp' ? (
              <div className="mt-1 space-y-2">
                <Input
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  placeholder={t('settings.ai.llamacppModelPlaceholder')}
                />
                {(() => {
                  const hardcoded =
                    PROVIDERS.find((p) => p.id === 'llamacpp')?.models.map((m) => m.id) ?? [];
                  const suggestions = [...new Set([...hardcoded, ...llamacppDiscoveredModels])];
                  return suggestions.length > 0 ? (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">{t('settings.ai.suggestions')}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {suggestions.map((name) => (
                          <button
                            key={name}
                            type="button"
                            onClick={() => setLlmModel(name)}
                            className="text-xs px-2 py-0.5 rounded-md border border-border bg-muted hover:bg-accent hover:text-accent-foreground transition-colors"
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            ) : (
              <div className="mt-1 space-y-2">
                <Select value={llmModel} onValueChange={setLlmModel}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('settings.ai.selectModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.find((p) => p.id === llmProvider)?.models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex items-center justify-between gap-2">
                          <span>{model.id === 'custom' ? t('settings.model.custom') : model.name}</span>
                          {model.description && (
                            <span className="text-xs text-muted-foreground">
                              {model.description === 'Best' ? t('settings.model.best')
                                : model.description === 'Fast & cheap' ? t('settings.model.fastCheap')
                                  : model.description === 'Fallback' ? t('settings.model.fallback')
                                    : model.description === 'Most capable' ? t('settings.model.mostCapable')
                                      : model.description === 'Best balance' ? t('settings.model.bestBalance')
                                        : model.description === 'Fast' ? t('settings.model.fast')
                                          : model.description === 'Capable' ? t('settings.model.capable')
                                            : model.description === 'Free via Gemini API' ? t('settings.model.freeGemini')
                                              : model.description === 'Flagship local model' ? t('settings.model.flagshipLocal')
                                                : model.description === 'Large local model' ? t('settings.model.largeLocal')
                                                  : model.description === 'Any GGUF loaded in llama-server' ? t('settings.model.anyGguf')
                                                    : model.description}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div>
                  <label className="text-xs text-muted-foreground">{t('settings.ai.customModel')}</label>
                  <Input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder={t('settings.ai.customModelPlaceholder')}
                    className="mt-1"
                  />
                  {customModel.trim() && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('settings.ai.customModelUsed', { model: customModel.trim() })}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* API Key (if required) */}
          {PROVIDERS.find((p) => p.id === llmProvider)?.requiresApiKey && (
            <div>
              <label className="text-sm font-medium">{t('settings.ai.apiKey')}</label>
              <Input
                type="password"
                value={llmApiKey}
                onChange={(e) => {
                  setLlmApiKey(e.target.value);
                  setLlmConfigured(false);
                }}
                placeholder={
                  llmConfigured
                    ? t('settings.ai.keepExistingKey')
                    : llmProvider === 'openai'
                      ? 'sk-...'
                      : llmProvider === 'anthropic'
                        ? 'sk-ant-...'
                        : 'AIza...'
                }
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings.ai.getApiKey')}{' '}
                <a
                  href={PROVIDERS.find((p) => p.id === llmProvider)?.apiKeyLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {PROVIDERS.find((p) => p.id === llmProvider)?.name}
                </a>
              </p>
            </div>
          )}

          {supportsCustomBaseUrl
            && llmProvider !== 'ollama'
            && llmProvider !== 'llamacpp' && (
            <div>
              <label className="text-sm font-medium">{t('settings.ai.baseUrlOptional')}</label>
              <Input
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder={t('settings.ai.officialApi', {
                  provider: PROVIDERS.find((p) => p.id === llmProvider)?.name ?? '',
                })}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t('settings.ai.officialApiHelp')}
              </p>
            </div>
          )}

          {/* llama.cpp: Base URL + model discovery button */}
          {supportsCustomBaseUrl && llmProvider === 'llamacpp' && (
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">{t('settings.ai.baseUrlOptional')}</label>
                <Input
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="http://localhost:8080"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('settings.ai.llamacppDefaultHelp')}{' '}
                  <code className="bg-muted px-0.5 rounded">llama-server -m &lt;model.gguf&gt;</code>
                </p>
              </div>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDiscoverLlamaCppModels}
                  disabled={llamacppDiscovering}
                >
                  {llamacppDiscovering ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      {t('settings.ai.discovering')}
                    </>
                  ) : (
                    t('settings.ai.discoverLoadedModel')
                  )}
                </Button>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('settings.ai.discoverHelp')}
                </p>
              </div>
            </div>
          )}

          {/* Ollama: Base URL + collapsible CORS instructions */}
          {supportsCustomBaseUrl && llmProvider === 'ollama' && (
            <>
              <div>
                <label className="text-sm font-medium">{t('settings.ai.baseUrlOptional')}</label>
                <Input
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('settings.ai.ollamaDefaultHelp')}
                </p>
              </div>

              {/* Collapsible CORS instructions */}
              <Collapsible open={ollamaCorsOpen} onOpenChange={setOllamaCorsOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-800 dark:hover:text-amber-200 transition-colors"
                  >
                    {ollamaCorsOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    {t('settings.ai.ollamaNotes')}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t('settings.ai.ollamaConnectionHelp')}
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t('settings.ai.ollamaEnsureRunning')}{' '}
                      <code className="bg-amber-100 dark:bg-amber-950/50 px-0.5 rounded">
                        ollama serve
                      </code>
                    </p>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}

          {/* Error message */}
          {llmTestError && <p className="text-sm text-red-500">{llmTestError}</p>}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button onClick={handleSaveLLMConfig} disabled={llmTesting || saveMutation.isPending}>
              {llmTesting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('settings.ai.testing')}
                </>
              ) : llmConfigured ? (
                t('settings.ai.update')
              ) : (
                t('settings.ai.saveAndTest')
              )}
            </Button>
            {llmConfigured && (
              <Button
                variant="outline"
                onClick={handleClearLLMConfig}
                disabled={saveMutation.isPending}
              >
                {t('settings.ai.clear')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.analysisLanguage.title')}</CardTitle>
          <CardDescription>{t('settings.analysisLanguage.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select
            value={analysisLanguage}
            onValueChange={(value) => void handleAnalysisLanguageChange(value as AnalysisLanguage)}
          >
            <SelectTrigger aria-label={t('settings.analysisLanguage.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t('settings.analysisLanguage.auto')}</SelectItem>
              <SelectItem value="zh-CN">{t('settings.analysisLanguage.zhCN')}</SelectItem>
              <SelectItem value="en-US">{t('settings.analysisLanguage.enUS')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('settings.analysisLanguage.help')}
          </p>
        </CardContent>
      </Card>

      {/* CLI Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('settings.cli.title')}</CardTitle>
          <CardDescription>
            {t('settings.cli.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted p-4 font-mono text-sm">
            <p className="text-muted-foreground">{t('settings.cli.install')}</p>
            <p>npm install -g @code-insights/cli</p>
            <p className="mt-2 text-muted-foreground">{t('settings.cli.initialize')}</p>
            <p>code-insights init</p>
            <p className="mt-2 text-muted-foreground">{t('settings.cli.sync')}</p>
            <p>code-insights sync</p>
            <p className="mt-2 text-muted-foreground">{t('settings.cli.openDashboard')}</p>
            <p>code-insights dashboard</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {t('settings.cli.privacy')}
          </p>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground pt-2 pb-4">
        Code Insights &mdash;{' '}
        <a
          href="https://github.com/melagiri/code-insights"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground transition-colors"
        >
          {t('settings.viewOnGithub')}
        </a>
      </div>
    </div>
  );
}
